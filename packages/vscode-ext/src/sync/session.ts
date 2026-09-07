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
import type { PersonalSyncClient } from './e2e/client';
import { assertU64Decimal, validateSyncState, type NewStateDto, type StateDto } from './e2e/types';
import { DekStore, deriveSyncSignKeyPair } from './crypto/keyStore';
import { encodeBase64Url } from './crypto/recoveryCode';
import type { ConnectionStore } from '../connection/connectionStore';
import type { CachedEntitlement } from './authService';
import { uniqueId } from '../utils/id';

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
}

interface EpochCleanupIntent {
  fromKeyEpoch: string;
  toKeyEpoch: string;
}

export class PersonalSyncSession {
  private static readonly EPOCH_CLEANUP_KEY = 'dbclient.sync.epochCleanup';

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

  /** 是否正处于失败退避重试的等待期。 */
  get retrying(): boolean {
    return this.coordinator?.retrying ?? false;
  }

  /** 当前 epoch 的待续跑 cleanup intent（有则说明上次切换中断）。 */
  get pendingCleanup(): { fromKeyEpoch: string; toKeyEpoch: string } | undefined {
    const i = this.readIntent();
    return i ? { fromKeyEpoch: i.fromKeyEpoch, toKeyEpoch: i.toKeyEpoch } : undefined;
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
      if (this.pendingCleanup) await this.resumeEpochTransition(snapshot);
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

  /** 解锁后的首次/手动同步，复用 coordinator 的单飞链。 */
  async syncNow() {
    if (!this.coordinator) throw new Error('sync session is locked');
    return this.coordinator.runNow();
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
  async resolveConflict(recordId: string, decision: 'local' | 'remote' | 'cancel'): Promise<void> {
    if (!this.resolver) throw new Error('sync session is locked');
    if (decision === 'local') await this.resolver.useLocal(recordId);
    else if (decision === 'remote') await this.resolver.useRemote(recordId);
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
  }

  /** 锁定：停止协调器，丢弃内存 DEK/signSeed（不删持久化 DEK）。 */
  lock(): void {
    this.coordinator?.stop();
    this.dek = undefined;
    this.signSeed = undefined;
  }

  /** 停用：extension deactivate 时经 context.subscriptions 触发。 */
  dispose(): void {
    this.lock();
  }

  /**
   * epoch 切换清理：③持久化新 snapshot → ④清旧 epoch recordMap/outbox → ⑤删旧 epoch DEK，
   * 带可重放 cleanup intent；失败中途留下 intent，由 resumeEpochTransition 完整幂等重放。
   * 删 DEK 只用 fromKeyEpoch（绝不误删新 epoch DEK）。参数 fail-closed：两个 epoch 须为
   * 规范 u64、toKeyEpoch > fromKeyEpoch、newSnapshot.keyEpoch === toKeyEpoch。
   * 清理始终按 fromKeyEpoch 显式构造旧 epoch store（不依赖会话内存字段），故重启后 resume
   * 也能清除旧 epoch 的持久化 recordMap/outbox。
   */
  async reconcileEpochTransition(fromKeyEpoch: string, toKeyEpoch: string, newSnapshot: SyncStateSnapshot): Promise<void> {
    assertU64Decimal(fromKeyEpoch, 'fromKeyEpoch');
    assertU64Decimal(toKeyEpoch, 'toKeyEpoch');
    assertU64Decimal(newSnapshot.keyEpoch, 'newSnapshot.keyEpoch');
    if (!(BigInt(toKeyEpoch) > BigInt(fromKeyEpoch))) {
      throw new Error('epoch transition toKeyEpoch must be greater than fromKeyEpoch');
    }
    if (newSnapshot.keyEpoch !== toKeyEpoch) {
      throw new Error('epoch transition snapshot keyEpoch does not match toKeyEpoch');
    }
    if (this.keyEpoch !== undefined && this.keyEpoch !== fromKeyEpoch) {
      throw new Error('epoch transition fromKeyEpoch mismatch');
    }
    this.coordinator?.stop();

    await this.writeIntent({ fromKeyEpoch, toKeyEpoch });
    await this.stateStore.setSnapshot(newSnapshot);
    await new RecordMapStore(this.memento, this.userId, fromKeyEpoch).clear();
    await new PendingMutationStore(this.memento, this.userId, fromKeyEpoch).clear();
    await new UnresolvedRefStore(this.memento, this.userId, fromKeyEpoch).clear();
    await this.dekStore.delete(this.userId, BigInt(fromKeyEpoch));
    await this.clearIntent();

    this.resetRuntime();
  }

  /** 检测到 cleanup intent 时完整幂等重放（clear/delete 幂等、setSnapshot 等值不抛）。 */
  async resumeEpochTransition(newSnapshot: SyncStateSnapshot): Promise<boolean> {
    const intent = this.readIntent();
    if (!intent) return false;
    assertU64Decimal(newSnapshot.keyEpoch, 'newSnapshot.keyEpoch');
    if (newSnapshot.keyEpoch !== intent.toKeyEpoch) {
      throw new Error('resume snapshot keyEpoch does not match intent toKeyEpoch');
    }
    await this.reconcileEpochTransition(intent.fromKeyEpoch, intent.toKeyEpoch, newSnapshot);
    return true;
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
  }

  private readIntent(): EpochCleanupIntent | undefined {
    const raw = this.memento.get<unknown>(PersonalSyncSession.EPOCH_CLEANUP_KEY + '.' + this.userId);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'object' || raw === null) throw new Error('corrupt epoch cleanup intent');
    const o = raw as Record<string, unknown>;
    if (typeof o.fromKeyEpoch !== 'string' || typeof o.toKeyEpoch !== 'string') {
      throw new Error('corrupt epoch cleanup intent');
    }
    return { fromKeyEpoch: o.fromKeyEpoch, toKeyEpoch: o.toKeyEpoch };
  }

  private async writeIntent(i: EpochCleanupIntent): Promise<void> {
    await this.memento.update(PersonalSyncSession.EPOCH_CLEANUP_KEY + '.' + this.userId, i);
  }

  private async clearIntent(): Promise<void> {
    await this.memento.update(PersonalSyncSession.EPOCH_CLEANUP_KEY + '.' + this.userId, undefined);
  }
}
