import { StateStore, type MementoLike, type SyncStateSnapshot } from './e2e/stateStore.js';
import { RecordMapStore } from './e2e/recordMapStore.js';
import { PendingMutationStore } from './e2e/pendingMutationStore.js';
import { DeferredRecordStore } from './e2e/deferredRecordStore.js';
import { SyncEngine } from './e2e/syncEngine.js';
import { SyncCoordinator } from './e2e/syncCoordinator.js';
import type { SyncRunResult } from './e2e/syncEngine.js';
import { ConflictResolver, type ConflictItem } from './e2e/conflictResolver.js';
import { EntityStore, UnresolvedRefStore, type EntityBackend } from './e2e/entityStore.js';
import type { SyncEntityType } from './e2e/syncEntity.js';
import { type PersonalSyncClient } from './e2e/client.js';
import { validateSyncState, type NewStateDto, type StateDto } from './e2e/types.js';
import { DekStore, deriveSyncSignKeyPair } from './crypto/keyStore.js';
import { encodeBase64Url } from './crypto/recoveryCode.js';
import type { ConnectionStore } from '../connection/connectionStore.js';
import type { CachedEntitlement } from './entitlementGate.js';
import { uniqueId } from '../utils/id.js';
import { EpochTransitionCoordinator } from './epochTransition.js';
import { buildSyncRuntime } from './runtimeFactory.js';
import { KeyLifecycleOps } from './keyLifecycleOps.js';

const LOCAL_ID_PREFIX: Record<SyncEntityType, string> = {
  connection: 'c',
  group: 'g',
  queryFolder: 'qf',
  query: 'q',
  authenticatorEntry: 'ae',
  authenticatorGroup: 'ag',
  authenticatorTag: 'at',
  schemaNotes: 'sn',
  aiModelAccess: 'ma',
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
 *   可重放 cleanup intent（devbelt.sync.epochCleanup.<userId>），任一中断后由
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
  /** 自动同步开关（按机器）；返回 false 时不自动同步（解锁首同步/本地变更/聚焦），仅显式命令触发。缺省开启。 */
  autoSyncEnabled?: () => boolean;
  /** P6：验证器同步实体后端（S3 由扩展注入）；缺省时验证器类型不可同步。 */
  authenticatorBackend?: EntityBackend;
  /** S7f：表/列注记实体后端（宿主注入，底层 AiContextStore）。 */
  schemaNotesBackend?: EntityBackend;
  /** AI 模型接入配置实体后端（宿主注入，底层 Memento 记录式存储）。 */
  aiModelAccessBackend?: EntityBackend;
  /** 选择性同步（按机器）：false 的类型不推送不应用（入站入 deferred，重开后重放）。 */
  typeEnabled?: (type: SyncEntityType) => boolean;
  /** P6：推送成功 / 按类型配额拒绝回调（由扩展接线标记本地实体）。 */
  onEntityPushed?: (ref: import('./e2e/syncEntity.js').SyncEntityRef) => void | Promise<void>;
  onQuotaRejected?: (ref: import('./e2e/syncEntity.js').SyncEntityRef) => void | Promise<void>;
  /** 同步进入 / 进行中进度（状态栏用）。 */
  onSyncStart?: (phase: 'pull' | 'push' | 'both') => void;
  onSyncProgress?: (p: import('./e2e/syncEngine.js').SyncProgress) => void;
}

export class PersonalSyncSession {
  private readonly stateStore: StateStore;
  private entities: EntityStore;
  private unresolved?: UnresolvedRefStore;
  private deferred?: DeferredRecordStore;
  private mapStore?: RecordMapStore;
  private outbox?: PendingMutationStore;
  private engine?: SyncEngine;
  private coordinator?: SyncCoordinator;
  private resolver?: ConflictResolver;
  private dek?: Uint8Array;
  private signSeed?: Uint8Array;
  private keyEpoch?: string;
  private readonly epochTx: EpochTransitionCoordinator;
  private readonly keyOps: KeyLifecycleOps;

  constructor(
    private readonly userId: string,
    private readonly memento: MementoLike,
    private readonly dekStore: DekStore,
    private readonly store: ConnectionStore,
    private readonly client: PersonalSyncClient,
    private readonly opts: SyncSessionOptions = {},
  ) {
    this.stateStore = new StateStore(memento, userId);
    this.entities = new EntityStore(store, opts.authenticatorBackend, opts.schemaNotesBackend, opts.aiModelAccessBackend, opts.typeEnabled);
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
    this.keyOps = new KeyLifecycleOps({
      userId,
      client,
      stateStore: this.stateStore,
      isUnlocked: () => this.isUnlocked,
      dek: () => this.dek,
      keyEpoch: () => this.keyEpoch,
      signSeed: () => this.signSeed,
      pendingCleanup: () => this.pendingCleanup,
      getRemoteState: () => this.getRemoteState(),
      unlockFromState: (state, dek) => this.unlockFromState(state, dek),
      installNewEpoch: (fromKeyEpoch, snapshot, dek) => this.installNewEpoch(fromKeyEpoch, snapshot, dek),
      writePendingIntent: (intent) => this.epochTx.writePending(intent),
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
    const signPair = deriveSyncSignKeyPair(dek);
    try {
      if (encodeBase64Url(signPair.publicKey) !== state.signPub) {
        throw new Error('sync state signing key does not match decrypted key');
      }
    } finally {
      signPair.seed.fill(0);
    }
    const local = this.stateStore.getSnapshot();
    // 解锁**不推进**本机 pull 游标：保留本机最后应用的 changeSequence，以便补拉「离线期间
    // 他设备上传」的记录；全新设备（无本地快照）从 0 拉全量历史。服务端 changeSequence 是
    // 用户级全局单调序列、永不重置（§7.3），故保留本机值不会回退、也不漏新记录。
    const snapshot: SyncStateSnapshot = {
      keyEpoch: state.keyEpoch,
      stateVersion: state.stateVersion,
      changeSequence: local?.changeSequence ?? '0',
    };
    const ownedDek = dek.slice();
    try {
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
      // 解锁是纯解锁：不在此排同步。是否/何时同步由自动同步开关（聚焦/本地变更）或显式命令决定。
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

  /** 体检检测（只读，零写入；需解锁）：逐条列出本地与云端的不一致（面板展示用）。 */
  async inspectFindings() {
    if (!this.coordinator) throw new Error('sync session is locked');
    return this.coordinator.findingsNow();
  }

  /** 修复用户选择的不一致项（缺省全部；方向 cloud=按云端 / local=用本机覆盖云端；需解锁）。写入仅由体检面板用户选择触发。 */
  async repairFindings(ids?: string[], direction?: 'cloud' | 'local' | 'merge') {
    if (!this.coordinator) throw new Error('sync session is locked');
    return this.coordinator.repairFindingsNow(ids, direction);
  }

  /** 立即排一次后台同步（不 await、不抛错）；供命令/窗口聚焦使用。 */
  scheduleNow(): void {
    if (!this.coordinator) throw new Error('sync session is locked');
    this.coordinator.scheduleNow();
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
    return this.keyOps.changeSyncPassword(oldSmp, newSmp);
  }

  /**
   * 恢复码恢复（锁定态）：旧恢复码解封 DEK + 旧 recoverSign 签名；新 SMP/新恢复码重封。
   * 成功后保存 DEK、更新 snapshot、解锁并排首次同步；返回新恢复码（一次性展示）。
   */
  async recoverSync(recoveryCode: string, newSmp: string): Promise<string> {
    return this.keyOps.recoverSync(recoveryCode, newSmp);
  }

  /**
   * 账号恢复（锁定态）：先以账户登录口令自证（服务端 step-up 复核），服务端下发
   * accountRecoveryKey + envelopeAccount → 解 DEK → 用 DEK 派生 syncSign 从新重设
   * 口令/恢复码/账号钥匙，数据不丢。返回新恢复码。
   */
  async recoverByAccount(accountPassword: string, newSmp: string): Promise<string> {
    return this.keyOps.recoverByAccount(accountPassword, newSmp);
  }

  /**
   * 销毁同步数据（解锁态）：当前 SMP 验证 + 全新 epoch 材料，走 epoch transition 幂等收敛。
   * 返回新恢复码（一次性展示）；旧 epoch DEK/store 被清理。
   */
  async destroySync(smp: string): Promise<string> {
    return this.keyOps.destroySync(smp);
  }

  /** 请求丢失 SMP 重置的邮件挑战（锁定态；服务端限流 + 防枚举恒同响应）。 */
  async requestResetChallenge(): Promise<void> {
    return this.keyOps.requestResetChallenge();
  }

  /**
   * 丢失 SMP 重置（锁定态）：凭浏览器交接的一次性 handoff ticket + 新 SMP。
   * 旧数据不可恢复。若本地有旧 epoch 则走 transition 清理；否则直接落新 epoch。
   * 服务端返回完整 StateDto；本方法只取三字段快照（新 DEK 在本地由新材料派生）。
   * 返回新恢复码。
   */
  async resetSyncAfterLoss(handoffTicket: string, newSmp: string): Promise<string> {
    return this.keyOps.resetSyncAfterLoss(handoffTicket, newSmp);
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
    // 换钥/恢复同样是纯生命周期动作：不自动同步，交由开关/显式命令。
  }

  /** 建立当前 epoch 的 recordMap/outbox/unresolved/deferred；epoch 与现存 store 不一致时抛错（不得静默沿用）。 */
  ensureStores(keyEpoch: string): void {
    if (this.keyEpoch !== undefined && this.keyEpoch !== keyEpoch) {
      throw new Error('sync session epoch mismatch');
    }
    this.keyEpoch = keyEpoch;
    if (!this.mapStore) this.mapStore = new RecordMapStore(this.memento, this.userId, keyEpoch);
    if (!this.outbox) this.outbox = new PendingMutationStore(this.memento, this.userId, keyEpoch);
    if (!this.unresolved) this.unresolved = new UnresolvedRefStore(this.memento, this.userId, keyEpoch);
    if (!this.deferred) this.deferred = new DeferredRecordStore(this.memento, this.userId, keyEpoch);
  }

  /** 载入 DEK 后建立并启动运行组件；epoch 与已构造 engine 不一致时抛错（须先走 transition）。 */
  unlock(keyEpoch: string, dek: Uint8Array): void {
    this.ensureStores(keyEpoch);
    this.dek = dek;
    this.signSeed = deriveSyncSignKeyPair(dek).seed;
    if (!this.engine) {
      const runtime = buildSyncRuntime({
        userId: this.userId,
        keyEpoch,
        client: this.client,
        stateStore: this.stateStore,
        mapStore: this.mapStore!,
        outbox: this.outbox!,
        unresolved: this.unresolved!,
        deferred: this.deferred!,
        entities: this.entities,
        store: this.store,
        dek: this.dekThunk,
        signSeed: this.signSeedThunk,
        uniqueId: (type) => this.uniqueEntityId(type),
        entitlement: this.opts.entitlement,
        typeEnabled: this.opts.typeEnabled,
        onSettled: this.opts.onSyncResult,
        autoSyncEnabled: this.opts.autoSyncEnabled,
        onEntityPushed: this.opts.onEntityPushed,
        onQuotaRejected: this.opts.onQuotaRejected,
        onSyncStart: this.opts.onSyncStart,
        onSyncProgress: this.opts.onSyncProgress,
      });
      this.engine = runtime.engine;
      this.coordinator = runtime.coordinator;
      this.resolver = runtime.resolver;
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
   *  - recordMap / pendingMutation / unresolved / deferred 四个 epoch 存储；
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
    this.deferred = undefined;
    this.engine = undefined;
    this.coordinator = undefined;
    this.resolver = undefined;
    this.dek = undefined;
    this.signSeed = undefined;
    this.keyEpoch = undefined;
    this.opts.onSessionState?.();
  }
}
