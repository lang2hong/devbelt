import { StateStore, type MementoLike, type SyncStateSnapshot } from './e2e/stateStore';
import { RecordMapStore } from './e2e/recordMapStore';
import { PendingMutationStore } from './e2e/pendingMutationStore';
import { SyncEngine } from './e2e/syncEngine';
import { SyncMutator } from './e2e/syncMutator';
import { SyncCoordinator } from './e2e/syncCoordinator';
import type { SyncRunResult } from './e2e/syncEngine';
import { ConflictResolver, type ConflictItem } from './e2e/conflictResolver';
import { EntityStore, UnresolvedRefStore } from './e2e/entityStore';
import type { SyncEntityType } from './e2e/syncEntity';
import { SyncApiError, type PersonalSyncClient } from './e2e/client';
import { assertU64Decimal, validateSyncState, type NewStateDto, type StateDto } from './e2e/types';
import { DekStore, deriveSyncSignKeyPair } from './crypto/keyStore';
import { encodeBase64Url, decodeBase64Url } from './crypto/recoveryCode';
import {
  createInitialMaterial,
  newRecoveryCode,
  unlockDek,
  buildChangeKeyMaterial,
  buildRecoverMaterial,
  buildRecoverByAccountMaterial,
  newStateFromMaterial,
  type InitialSyncMaterial,
  type RecoverMaterial,
  type RecoverByAccountMaterial,
} from './keyLifecycle';
import { hkdfSha256, SYNC_INFO } from './crypto/hkdf';
import { openEnvelope } from './envelope';
import type { ConnectionStore } from '../connection/connectionStore';
import type { CachedEntitlement } from './authService';
import { uniqueId } from '../utils/id';
import { randomBytes } from 'crypto';
import { EpochTransitionCoordinator } from './epochTransition';

const LOCAL_ID_PREFIX: Record<SyncEntityType, string> = {
  connection: 'c',
  group: 'g',
  queryFolder: 'qf',
  query: 'q',
};

/**
 * 个人同步会话（compose root 层）：统一持有本地 store、同步引擎、出站生成与本地变更
 * 协调器，并管理三态生命周期：
 *
 *   - 已登录未解锁：仅 StateStore（keyed by userId）；
 *     `ensureStores(keyEpoch)` 建立当前 epoch 的 recordMap/outbox（不需 DEK）。
 *   - 已解锁：`unlock(keyEpoch, dek)` 载入 DEK 后建立 SyncEngine/SyncMutator/SyncCoordinator
 *     并 start()；同一会话复用、不重建 engine（保证单飞语义）。
 *   - 锁定/停用：`lock()` stop 协调器并丢弃内存 DEK/signSeed；`dispose()` 供 extension
 *     deactivation（经 context.subscriptions 触发）。lock/dispose 不等待在途 drain，靠 outbox
 *     原样重放收敛（§7.4/§7.6）；在途 thunk 未解锁时抛 'sync session locked'。
 *
 * epoch 切换（destroy/reset-after-loss）：
 *   reconcileEpochTransition(fromKeyEpoch, toKeyEpoch, newSnapshot) 自己按
 *   ③ 持久化新 snapshot → ④ 清旧 epoch recordMap/outbox → ⑤ 删旧 epoch DEK 执行，写入
 *   可重放 cleanup intent（dbclient.sync.epochCleanup.<userId>），任一中断后由
 *   resumeEpochTransition() 完整幂等重放（clear/delete 幂等、setSnapshot 等值重放不抛）。
 *   changeSequence 全局不回退、绝不本地重置（§7.3）。
 */

export interface SyncSessionOptions {
  entitlement?: () => CachedEntitlement | undefined;
  uniqueConnectionId?: () => string;
  /** 每轮后台 sync 结束（含失败）后回调；供扩展层刷树/更新状态栏。 */
  onSyncResult?: (result: SyncRunResult | undefined) => void;
  /** 会话锁定态变化（unlock/lock/epoch transition）后同步回调；供命令门控 context 即时刷新。 */
  onSessionState?: () => void;
}

export class PersonalSyncSession {
  private readonly stateStore: StateStore;
  private entities: EntityStore;
  private unresolved?: UnresolvedRefStore;
  private mapStore?: RecordMapStore;
  private outbox?: PendingMutationStore;
  private engine?: SyncEngine;
  private mutator?: SyncMutator;
  private coordinator?: SyncCoordinator;
  private resolver?: ConflictResolver;
  private dek?: Uint8Array;
  private signSeed?: Uint8Array;
  private keyEpoch?: string;
  private readonly epochTx: EpochTransitionCoordinator;

  constructor(
    private readonly userId: string,
    private readonly memento: MementoLike,
    private readonly dekStore: DekStore,
    private readonly store: ConnectionStore,
    private readonly client: PersonalSyncClient,
    private readonly opts: SyncSessionOptions = {},
  ) {
    this.stateStore = new StateStore(memento, userId);
    this.entities = new EntityStore(store);
    this.epochTx = new EpochTransitionCoordinator({
      memento,
      userId,
      dekStore,
      stateStore: this.stateStore,
      entities: this.entities,
      currentEpoch: () => this.keyEpoch,
      stopCoordinator: () => this.coordinator?.stop(),
      resetRuntime: () => this.resetRuntime(),
    });
  }

  private uniqueEntityId(type: SyncEntityType): string {
    if (type === 'connection' && this.opts.uniqueConnectionId) return this.opts.uniqueConnectionId();
    return uniqueId(LOCAL_ID_PREFIX[type]);
  }

  /** 是否已解锁（DEK 在内存） */
  get isUnlocked(): boolean {
    return this.dek !== undefined;
  }

  /** 会话所属 userId（规范 u64 字符串）。 */
  get uid(): string {
    return this.userId;
  }

  /** 最近一次后台协调失败原因（不含秘密）；成功轮次已清空。 */
  get lastError(): string | undefined {
    return this.coordinator?.lastError;
  }

  /** 最近一次后台 sync 结构化结果（terminal/conflict/stalled 不丢）。 */
  get lastRun() {
    return this.coordinator?.lastRun;
  }

  /** 是否因 terminal/conflict/epoch-mismatch/paging-stalled 已停止自动重试。 */
  get stalled(): boolean {
    return this.coordinator?.stalled ?? false;
  }

  /** 远端 epoch 已前进（他设备 destroy/reset 等），需要重新输入 SMP 解锁新 epoch。 */
  get epochStale(): boolean {
    const r = this.coordinator?.lastRun;
    if (!r) return false;
    return r.stage === 'epoch-mismatch' || r.terminal?.code === 'SYNC_EPOCH_STALE';
  }

  /** 本地已持久化的 keyEpoch（未初始化则为 undefined）。 */
  get localEpoch(): string | undefined {
    return this.stateStore.getSnapshot()?.keyEpoch;
  }

  /** 是否正处于失败退避重试的等待期。 */
  get retrying(): boolean {
    return this.coordinator?.retrying ?? false;
  }

  /** 当前 epoch 的待续跑 cleanup intent（有则说明上次切换中断）。 */
  get pendingCleanup(): { fromKeyEpoch: string; toKeyEpoch: string } | undefined {
    return this.epochTx.pending;
  }

  getStateStore(): StateStore {
    return this.stateStore;
  }

  /** 拉取并严格校验远端状态；命令层不得直接信任网络响应。 */
  async getRemoteState(): Promise<StateDto> {
    return validateSyncState(await this.client.getState());
  }

  /** 初始化成功后才落盘 DEK/snapshot，随后启动会话。 */
  async initializeSync(newState: NewStateDto, dek: Uint8Array): Promise<void> {
    await this.client.init(newState);
    const snapshot: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '1', changeSequence: '0' };
    const ownedDek = dek.slice();
    try {
      await this.dekStore.store(this.userId, 1n, ownedDek);
      await this.stateStore.setSnapshot(snapshot);
      this.unlock(snapshot.keyEpoch, ownedDek);
    } catch (err) {
      ownedDek.fill(0);
      throw err;
    }
  }

  /**
   * 对已存在 state 完成解锁。cleanup intent 必须先用远端确认快照收敛，再写当前 epoch
   * 的 DEK/snapshot；任一步失败都不会启动 coordinator。
   */
  async unlockFromState(state: StateDto, dek: Uint8Array): Promise<void> {
    if (encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) !== state.signPub) {
      throw new Error('sync state signing key does not match decrypted key');
    }
    const snapshot: SyncStateSnapshot = {
      keyEpoch: state.keyEpoch,
      stateVersion: state.stateVersion,
      changeSequence: state.changeSequence,
    };
    const ownedDek = dek.slice();
    try {
      const local = this.stateStore.getSnapshot();
      if (this.pendingCleanup) {
        await this.resumeEpochTransition(snapshot);
      } else if (local && BigInt(local.keyEpoch) < BigInt(state.keyEpoch)) {
        // 远端 epoch 前进（他设备 destroy/reset 等）：清理本地旧 epoch 的三类 store 与 DEK，
        // 避免旧 epoch 键成为孤儿、并防止 ensureStores 因 epoch 不一致抛错。
        await this.reconcileEpochTransition(local.keyEpoch, state.keyEpoch, snapshot);
      }
      await this.dekStore.store(this.userId, BigInt(snapshot.keyEpoch), ownedDek);
      await this.stateStore.setSnapshot(snapshot);
      this.unlock(snapshot.keyEpoch, ownedDek);
      // 解锁路径即排首次同步（幂等）；初始化路径走 initializeSync，不在此触发（等恢复码确认）。
      this.scheduleInitialSync();
    } catch (err) {
      ownedDek.fill(0);
      throw err;
    }
  }

  /**
   * 自动恢复解锁（方案 B）：重启后若本地已持久化 DEK（SecretStorage）且与远端 state 匹配，
   * 直接解锁，跳过「输入同步口令」。任何条件不满足或异常都返回 false，回退到口令解锁。
   * 门禁：signPub 不匹配会使 unlockFromState 抛错（fail-closed）；epoch 差异走
   * reconcileEpochTransition 收敛，不抛错。无 DEK / 无快照则此处直接返回 false。
   */
  async tryRestoreUnlock(): Promise<boolean> {
    if (this.isUnlocked) return false;
    const local = this.stateStore.getSnapshot();
    if (!local) return false;
    try {
      const dek = await this.dekStore.load(this.userId, BigInt(local.keyEpoch));
      if (!dek) return false;
      const state = await this.getRemoteState();
      await this.unlockFromState(state, dek);
      return true;
    } catch {
      return false;
    }
  }

  /** 解锁后的首次/手动同步，复用 coordinator 的单飞链。 */
  async syncNow() {
    if (!this.coordinator) throw new Error('sync session is locked');
    return this.coordinator.runNow();
  }

  /** 显式拉取：仅拉取远端 feed（不推送本地变更）。 */
  async syncPull() {
    if (!this.coordinator) throw new Error('sync session is locked');
    return this.coordinator.pullNow();
  }

  /** 显式推送：先生成本地变更 mutation，再重放出站。 */
  async syncPush() {
    if (!this.coordinator) throw new Error('sync session is locked');
    return this.coordinator.pushNow();
  }

  /** 立即排一次后台同步（不 await、不抛错）；供命令/窗口聚焦使用。 */
  scheduleNow(): void {
    if (!this.coordinator) throw new Error('sync session is locked');
    this.coordinator.scheduleNow();
  }

  /** 解锁后的首次同步（幂等）；供扩展层在解锁/首次聚焦时保证至少同步一次。 */
  scheduleInitialSync(): void {
    if (!this.coordinator) throw new Error('sync session is locked');
    this.coordinator.scheduleInitialSync();
  }

  /** B4：当前未解决冲突（来自 outbox 的 conflict 字段）。 */
  listConflicts(): ConflictItem[] {
    return this.resolver?.list() ?? [];
  }

  /** B4：三态迁移。cancel 为 noop；local/remote 由 ConflictResolver 原子执行。 */
  async resolveConflict(recordId: string, decision: 'local' | 'merge' | 'remote' | 'cancel'): Promise<void> {
    if (!this.resolver) throw new Error('sync session is locked');
    if (decision === 'local') await this.resolver.useLocal(recordId);
    else if (decision === 'merge') await this.resolver.useMerge(recordId);
    else if (decision === 'remote') await this.resolver.useRemote(recordId);
  }

  // ── B5 生命周期 ──

  /**
   * 修改同步口令（解锁态）：旧 SMP 验证 + 新 SMP 重封 smp envelope（recovery 不变，DEK 不变）。
   * 失败不改本地 snapshot/DEK。签名用当前内存 syncSign（命令层不接触私钥）。
   */
  async changeSyncPassword(oldSmp: string, newSmp: string): Promise<void> {
    if (!this.dek || !this.keyEpoch || !this.signSeed) throw new Error('sync session is locked');
    const state = await this.getRemoteState();
    if (state.keyEpoch !== this.keyEpoch) throw new Error('sync epoch mismatch');
    const material = await buildChangeKeyMaterial(
      this.userId, this.keyEpoch, oldSmp, state.smpKdf, state.envelopeSmp, newSmp,
    );
    try {
      if (!byteEq(material.verifiedDek, this.dek)) throw new Error('sync passphrase mismatch');
      const local = this.stateStore.getSnapshot();
      if (!local) throw new Error('sync session has no local state');
      const res = await this.client.changeKey({
        userId: this.userId,
        keyEpoch: this.keyEpoch,
        mutationId: this.mintMutationId(),
        seed: this.signSeed,
        expectedStateVersion: local.stateVersion,
        smpKdf: material.smpKdf,
        envelopeSmp: material.envelopeSmp,
      });
      const stateVersion = this.assertSameEpochReceipt(res, this.keyEpoch);
      await this.stateStore.setSnapshot({ keyEpoch: this.keyEpoch, stateVersion, changeSequence: local.changeSequence });
    } finally {
      material.verifiedDek.fill(0);
    }
  }

  /**
   * 恢复码恢复（锁定态）：旧恢复码解封 DEK + 旧 recoverSign 签名；新 SMP/新恢复码重封。
   * 成功后保存 DEK、更新 snapshot、解锁并排首次同步；返回新恢复码（一次性展示）。
   */
  async recoverSync(recoveryCode: string, newSmp: string): Promise<string> {
    if (this.isUnlocked) throw new Error('sync session already unlocked');
    const state = await this.getRemoteState();
    const oldRecoveryRaw = decodeBase64Url(recoveryCode.replace(/\s+/g, ''));
    const newRecovery = newRecoveryCode();
    let material: RecoverMaterial | undefined;
    try {
      material = await buildRecoverMaterial(
        this.userId, state.keyEpoch, oldRecoveryRaw, state.recoveryKdf, state.envelopeRecovery,
        state.envelopeSmp.envelopeVersion, newSmp, newRecovery.raw,
      );
      await this.client.recover({
        userId: this.userId,
        keyEpoch: state.keyEpoch,
        mutationId: this.mintMutationId(),
        seed: material.oldRecoverSignSeed,
        expectedStateVersion: state.stateVersion,
        smpKdf: material.smpKdf,
        envelopeSmp: material.envelopeSmp,
        recoveryKdf: material.recoveryKdf,
        envelopeRecovery: material.envelopeRecovery,
        recoverSignPub: material.recoverSignPub,
      });
      const newState = await this.getRemoteState();
      // 复用 unlockFromState 的 signPub 一致性校验 + 完整解锁语义（验证恢复出的 DEK 确属该 state）。
      await this.unlockFromState(newState, material.dek);
      return newRecovery.code;
    } finally {
      oldRecoveryRaw.fill(0);
      newRecovery.raw.fill(0);
      material?.dek.fill(0);
      material?.oldRecoverSignSeed.fill(0);
    }
  }

  /**
   * 账号恢复（锁定态）：先以账户登录口令自证（服务端 step-up 复核），服务端下发
   * accountRecoveryKey + envelopeAccount → 解 DEK → 用 DEK 派生 syncSign 从新重设
   * 口令/恢复码/账号钥匙，数据不丢。返回新恢复码。
   */
  async recoverByAccount(accountPassword: string, newSmp: string): Promise<string> {
    if (this.isUnlocked) throw new Error('sync session already unlocked');
    const state = await this.getRemoteState();
    const accountMaterial = await this.client.recoverViaAccount(accountPassword);
    const oldAccountKey = decodeBase64Url(accountMaterial.accountRecoveryKey);
    const kekAccount = hkdfSha256(oldAccountKey, new Uint8Array(0), SYNC_INFO.kekAccount);
    let dek: Uint8Array;
    try {
      dek = openEnvelope(kekAccount, accountMaterial.envelopeAccount, this.userId, state.keyEpoch, 'account');
    } finally {
      kekAccount.fill(0);
      oldAccountKey.fill(0);
    }
    // 恢复出的 DEK 必须确属该 state（signPub 一致性），否则拒绝。
    if (encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) !== state.signPub) {
      dek.fill(0);
      throw new Error('account recovery key does not match sync state');
    }

    const newRecovery = newRecoveryCode();
    const newAccountRaw = new Uint8Array(randomBytes(32));
    let material: RecoverByAccountMaterial | undefined;
    try {
      material = await buildRecoverByAccountMaterial(
        this.userId,
        state.keyEpoch,
        dek,
        state.envelopeSmp.envelopeVersion,
        state.envelopeRecovery.envelopeVersion,
        accountMaterial.envelopeAccount.envelopeVersion,
        newSmp,
        newRecovery.raw,
        newAccountRaw,
      );
      await this.client.accountRecover({
        userId: this.userId,
        keyEpoch: state.keyEpoch,
        mutationId: this.mintMutationId(),
        seed: material.signSeed,
        expectedStateVersion: state.stateVersion,
        smpKdf: material.smpKdf,
        envelopeSmp: material.envelopeSmp,
        recoveryKdf: material.recoveryKdf,
        envelopeRecovery: material.envelopeRecovery,
        envelopeAccount: material.envelopeAccount,
        accountRecoveryKey: encodeBase64Url(newAccountRaw),
        recoverSignPub: material.recoverSignPub,
      });
      const newState = await this.getRemoteState();
      await this.unlockFromState(newState, dek);
      return newRecovery.code;
    } finally {
      dek.fill(0);
      newRecovery.raw.fill(0);
      newAccountRaw.fill(0);
      material?.signSeed.fill(0);
    }
  }

  /**
   * 销毁同步数据（解锁态）：当前 SMP 验证 + 全新 epoch 材料，走 epoch transition 幂等收敛。
   * 返回新恢复码（一次性展示）；旧 epoch DEK/store 被清理。
   */
  async destroySync(smp: string): Promise<string> {
    if (!this.dek || !this.keyEpoch || !this.signSeed) throw new Error('sync session is locked');
    const state = await this.getRemoteState();
    if (state.keyEpoch !== this.keyEpoch) throw new Error('sync epoch mismatch');
    const verified = await unlockDek(this.userId, this.keyEpoch, smp, state.smpKdf, state.envelopeSmp);
    try {
      if (!byteEq(verified, this.dek)) throw new Error('sync passphrase mismatch');
    } finally {
      verified.fill(0);
    }

    const fromKeyEpoch = this.keyEpoch;
    const newKeyEpoch = String(BigInt(fromKeyEpoch) + 1n);
    const newRecovery = newRecoveryCode();
    let material: InitialSyncMaterial | undefined;
    try {
      material = await createInitialMaterial(this.userId, newKeyEpoch, smp, newRecovery.raw);
      const local = this.stateStore.getSnapshot();
      if (!local) throw new Error('sync session has no local state');
      // 不可逆请求前先落 durable transition intent：即使回执丢失/响应中断，重启后可据远端 state
      // 判定提交结果（toKeyEpoch 命中 → 清理；fromKeyEpoch 命中 → 撤销）收敛旧 epoch。
      await this.epochTx.writePending({ fromKeyEpoch, toKeyEpoch: newKeyEpoch });
      const res = await this.client.destroy({
        userId: this.userId,
        keyEpoch: fromKeyEpoch,
        mutationId: this.mintMutationId(),
        seed: this.signSeed,
        expectedStateVersion: local.stateVersion,
        newState: newStateFromMaterial(material),
      });
      const ownedDek = material.dek.slice();
      const newSnapshot = this.assertEpochAdvanceReceipt(res, newKeyEpoch);
      await this.installNewEpoch(fromKeyEpoch, newSnapshot, ownedDek);
      return newRecovery.code;
    } finally {
      newRecovery.raw.fill(0);
      material?.dek.fill(0);
      material?.accountRecoveryKey.fill(0);
    }
  }

  /** 请求丢失 SMP 重置的邮件挑战（锁定态；服务端限流 + 防枚举恒同响应）。 */
  async requestResetChallenge(): Promise<void> {
    await this.client.resetChallenges();
  }

  /**
   * 丢失 SMP 重置（锁定态）：凭浏览器交接的一次性 handoff ticket + 新 SMP。
   * 旧数据不可恢复。若本地有旧 epoch 则走 transition 清理；否则直接落新 epoch。
   * 服务端返回完整 StateDto；本方法只取三字段快照（新 DEK 在本地由新材料派生）。
   * 返回新恢复码。
   */
  async resetSyncAfterLoss(handoffTicket: string, newSmp: string): Promise<string> {
    if (this.isUnlocked) throw new Error('sync session already unlocked; use destroy instead');
    // 已有未收敛的 epoch-cleanup journal 时拒绝 reset：否则会用新 intent 覆盖旧的单键 journal，
    // 使更旧 epoch 的本地状态（recordMap/outbox/unresolved/DEK）失去清理入口而永久残留。
    if (this.pendingCleanup) {
      throw new Error('pending sync cleanup in progress; unlock to finish it before resetting');
    }
    let newKeyEpoch: string;
    try {
      const remote = await this.getRemoteState();
      newKeyEpoch = String(BigInt(remote.keyEpoch) + 1n);
    } catch (err) {
      if (err instanceof SyncApiError && err.status === 400 && err.code === 'SYNC_NOT_INITIALIZED') {
        newKeyEpoch = '1';
      } else {
        throw err;
      }
    }
    const localEpoch = this.stateStore.getSnapshot()?.keyEpoch;
    const hasLocalEpoch = localEpoch !== undefined && BigInt(localEpoch) < BigInt(newKeyEpoch);
    const newRecovery = newRecoveryCode();
    let material: InitialSyncMaterial | undefined;
    try {
      material = await createInitialMaterial(this.userId, newKeyEpoch, newSmp, newRecovery.raw);
      // 本地下有旧 epoch 时才须清理；请求前先落 durable intent 覆盖「远端已提交、ticket 已消费、
      // 回执丢失」的未知结果窗口（同 ticket 同 newState 重试仅 3 次，且 ticket 单次消费）。
      if (hasLocalEpoch) await this.epochTx.writePending({ fromKeyEpoch: localEpoch as string, toKeyEpoch: newKeyEpoch });
      const res = await this.client.resetAfterLossWithHandoff(handoffTicket, newStateFromMaterial(material));
      const ownedDek = material.dek.slice();
      const newSnapshot = this.assertEpochAdvanceReceipt(res, newKeyEpoch);
      const fromKeyEpoch = hasLocalEpoch ? (localEpoch as string) : undefined;
      await this.installNewEpoch(fromKeyEpoch, newSnapshot, ownedDek);
      return newRecovery.code;
    } finally {
      newRecovery.raw.fill(0);
      material?.dek.fill(0);
      material?.accountRecoveryKey.fill(0);
    }
  }

  private mintMutationId(): string {
    return encodeBase64Url(new Uint8Array(randomBytes(16)));
  }

  /** 落新 epoch：intent 先行 → 存新 DEK → transition 清旧 epoch → unlock → 首次同步。 */
  private async installNewEpoch(fromKeyEpoch: string | undefined, newSnapshot: SyncStateSnapshot, newDek: Uint8Array): Promise<void> {
    const newKeyEpoch = newSnapshot.keyEpoch;
    try {
      if (fromKeyEpoch !== undefined && BigInt(fromKeyEpoch) < BigInt(newKeyEpoch)) {
        // newDek 一并传入，使「存新 DEK」落在 transition 的 writeIntent 之后（可恢复序列的一部分）。
        await this.reconcileEpochTransition(fromKeyEpoch, newKeyEpoch, newSnapshot, newDek);
      } else {
        this.coordinator?.stop();
        this.resetRuntime();
        await this.dekStore.store(this.userId, BigInt(newKeyEpoch), newDek);
        this.ensureStores(newKeyEpoch);
        await this.stateStore.setSnapshot(newSnapshot);
      }
      this.unlock(newKeyEpoch, newDek);
    } catch (err) {
      // 失败路径清零 newDek（成功后 newDek 由 this.dek 持有，不在此清零）。
      newDek.fill(0);
      throw err;
    }
    this.scheduleInitialSync();
  }

  /** 校验「同 epoch 状态变更」回执（change-key），返回新的 stateVersion。 */
  private assertSameEpochReceipt(res: unknown, expectedKeyEpoch: string): string {
    if (typeof res !== 'object' || res === null) throw new Error('malformed sync receipt');
    const o = res as Record<string, unknown>;
    if (typeof o.keyEpoch !== 'string' || typeof o.stateVersion !== 'string') throw new Error('malformed sync receipt');
    assertU64Decimal(o.keyEpoch, 'receipt.keyEpoch');
    assertU64Decimal(o.stateVersion, 'receipt.stateVersion');
    if (o.keyEpoch !== expectedKeyEpoch) throw new Error('sync receipt epoch mismatch');
    return o.stateVersion;
  }

  /** 校验「epoch 前进」回执（destroy/reset），返回三字段快照；epoch 必须等于预期 next。 */
  private assertEpochAdvanceReceipt(res: unknown, expectedKeyEpoch: string): SyncStateSnapshot {
    if (typeof res !== 'object' || res === null) throw new Error('malformed sync receipt');
    const o = res as Record<string, unknown>;
    if (typeof o.keyEpoch !== 'string' || typeof o.stateVersion !== 'string' || typeof o.changeSequence !== 'string') {
      throw new Error('malformed sync receipt');
    }
    assertU64Decimal(o.keyEpoch, 'receipt.keyEpoch');
    assertU64Decimal(o.stateVersion, 'receipt.stateVersion', true);
    assertU64Decimal(o.changeSequence, 'receipt.changeSequence', true);
    if (o.keyEpoch !== expectedKeyEpoch) throw new Error('sync receipt epoch mismatch');
    return { keyEpoch: o.keyEpoch, stateVersion: o.stateVersion, changeSequence: o.changeSequence };
  }

  /** 建立当前 epoch 的 recordMap/outbox/unresolved；epoch 与现存 store 不一致时抛错（不得静默沿用）。 */
  ensureStores(keyEpoch: string): void {
    if (this.keyEpoch !== undefined && this.keyEpoch !== keyEpoch) {
      throw new Error('sync session epoch mismatch');
    }
    this.keyEpoch = keyEpoch;
    if (!this.mapStore) this.mapStore = new RecordMapStore(this.memento, this.userId, keyEpoch);
    if (!this.outbox) this.outbox = new PendingMutationStore(this.memento, this.userId, keyEpoch);
    if (!this.unresolved) this.unresolved = new UnresolvedRefStore(this.memento, this.userId, keyEpoch);
  }

  /** 载入 DEK 后建立并启动运行组件；epoch 与已构造 engine 不一致时抛错（须先走 transition）。 */
  unlock(keyEpoch: string, dek: Uint8Array): void {
    this.ensureStores(keyEpoch);
    this.dek = dek;
    this.signSeed = deriveSyncSignKeyPair(dek).seed;
    if (!this.engine) {
      this.mutator = new SyncMutator({
        userId: this.userId,
        keyEpoch,
        entities: this.entities,
        mapStore: this.mapStore!,
        outbox: this.outbox!,
        dek: this.dekThunk,
        signSeed: this.signSeedThunk,
      });
      this.engine = new SyncEngine({
        userId: this.userId,
        keyEpoch,
        client: this.client,
        stateStore: this.stateStore,
        mapStore: this.mapStore!,
        outbox: this.outbox!,
        entities: this.entities,
        unresolved: this.unresolved!,
        dek: this.dekThunk,
        signSeed: this.signSeedThunk,
        uniqueId: (type) => this.uniqueEntityId(type),
        entitlement: this.opts.entitlement,
        seedConflictCarrier: (recordId, ref, baseVersion) => this.mutator!.rebasePut(recordId, ref, baseVersion),
      });
      this.coordinator = new SyncCoordinator(this.store, this.mutator, this.engine, {
        onSettled: this.opts.onSyncResult,
      });
      this.resolver = new ConflictResolver({
        userId: this.userId,
        keyEpoch,
        mapStore: this.mapStore!,
        outbox: this.outbox!,
        entities: this.entities,
        unresolved: this.unresolved!,
        dek: this.dekThunk,
        mutator: this.mutator,
        entitlement: this.opts.entitlement,
        uniqueId: (type) => this.uniqueEntityId(type),
      });
    }
    this.coordinator!.start();
    this.opts.onSessionState?.();
  }

  /** 锁定：停止协调器，丢弃内存 DEK/signSeed（不删持久化 DEK）。 */
  lock(): void {
    this.coordinator?.stop();
    this.dek = undefined;
    this.signSeed = undefined;
    this.opts.onSessionState?.();
  }

  /**
   * 纯本地重置：清空本机同步数据与持久化 DEK，回到未初始化态。
   *
   * 与远端 `resetSync`（需 handoff）不同，这里**不发起任何 sync API 请求**，
   * 供远端不可达 / stale-epoch 时逃生。仅清 sync 自有存储：
   *  - 该 epoch 映射到的本地实体（软删 source='sync'，级联子树）；
   *  - recordMap / pendingMutation / unresolved 三个 epoch 存储；
   *  - 持久化 DEK、状态快照、残留 cleanup intent。
   * 连接/查询等业务数据不在 sync 存储内，天然保留。幂等。
   */
  async clearLocalState(): Promise<void> {
    this.coordinator?.stop();

    // 需要清理的 epoch = 快照 epoch + 残留 cleanup intent 的 from/to。
    // 只清快照 epoch 会漏掉 intent 涉及的旧 epoch（其 recordMap/outbox/unresolved/DEK 成为孤儿）。
    const epochs = new Set<string>();
    const snap = this.stateStore.getSnapshot();
    if (snap) epochs.add(snap.keyEpoch);
    const intent = this.epochTx.pending;
    if (intent) {
      epochs.add(intent.fromKeyEpoch);
      epochs.add(intent.toKeyEpoch);
    }

    for (const epoch of epochs) {
      await this.epochTx.clearEpoch(epoch);
    }

    await this.stateStore.clear();
    await this.epochTx.clearPending();
    this.resetRuntime();
  }

  /** 停用：extension deactivate 时经 context.subscriptions 触发。 */
  dispose(): void {
    this.lock();
  }

  /**
   * epoch 切换清理（委托 EpochTransitionCoordinator）：写 durable intent → （可选）存新 epoch DEK →
   * 持久化新 snapshot → 清旧 epoch 实体/recordMap/outbox/unresolved → 删旧 epoch DEK → 清 intent。
   * 失败中途留下 intent，由 resumeEpochTransition 完整幂等重放；intent 是第一个持久化动作，
   * 保证「新 DEK 落盘」等任何可存活步骤之前已有恢复标记（§7.4 崩溃窗口收敛）。
   * 参数 fail-closed：两个 epoch 须为规范 u64、toKeyEpoch > fromKeyEpoch、newSnapshot.keyEpoch === toKeyEpoch。
   */
  async reconcileEpochTransition(fromKeyEpoch: string, toKeyEpoch: string, newSnapshot: SyncStateSnapshot, newDek?: Uint8Array): Promise<void> {
    return this.epochTx.reconcile(fromKeyEpoch, toKeyEpoch, newSnapshot, newDek);
  }

  /** 检测到 cleanup intent 时完整幂等重放（clear/delete 幂等、setSnapshot 等值不抛）。 */
  async resumeEpochTransition(newSnapshot: SyncStateSnapshot): Promise<boolean> {
    return this.epochTx.resume(newSnapshot);
  }

  private dekThunk = (): Uint8Array => {
    if (!this.dek) throw new Error('sync session locked');
    return this.dek;
  };

  private signSeedThunk = (): Uint8Array => {
    if (!this.signSeed) throw new Error('sync session locked');
    return this.signSeed;
  };

  private resetRuntime(): void {
    this.mapStore = undefined;
    this.outbox = undefined;
    this.unresolved = undefined;
    this.engine = undefined;
    this.mutator = undefined;
    this.coordinator = undefined;
    this.resolver = undefined;
    this.dek = undefined;
    this.signSeed = undefined;
    this.keyEpoch = undefined;
    this.opts.onSessionState?.();
  }
}

/** 恒定时间字节比较（密钥/DEK 比对用）。 */
function byteEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a[i] ^ b[i];
  return d === 0;
}
