import type { StateStore, MementoLike, SyncStateSnapshot } from './e2e/stateStore';
import { RecordMapStore } from './e2e/recordMapStore';
import { PendingMutationStore } from './e2e/pendingMutationStore';
import { UnresolvedRefStore, type EntityStore } from './e2e/entityStore';
import type { DekStore } from './crypto/keyStore';
import { assertU64Decimal } from './e2e/types';

export interface EpochCleanupIntent {
  fromKeyEpoch: string;
  toKeyEpoch: string;
}

export interface EpochTransitionDeps {
  memento: MementoLike;
  userId: string;
  dekStore: DekStore;
  stateStore: StateStore;
  entities: EntityStore;
  /** 会话当前 epoch（未建立为 undefined）；reconcile 用它做 fromKeyEpoch 一致性校验。 */
  currentEpoch: () => string | undefined;
  /** 切换前停止协调器（停止在途 drain）。 */
  stopCoordinator: () => void;
  /** 切换后丢弃运行组件/密钥并广播状态变化。 */
  resetRuntime: () => void;
}

/**
 * epoch 切换与旧 epoch 清理（自 PersonalSyncSession 抽出，逐字搬移）。
 *
 * 负责「durable cleanup intent + 旧 epoch 三类 store/DEK 清理」，是崩溃窗口收敛的
 * 单一实现点：intent 是第一个持久化动作，中断后由 resume() 完整幂等重放。
 * 生命周期（停协调器/重置运行组件/广播）通过 deps 端口回注，本模块不感知会话其余状态。
 */
export class EpochTransitionCoordinator {
  private static readonly EPOCH_CLEANUP_KEY = 'dbclient.sync.epochCleanup';

  constructor(private readonly deps: EpochTransitionDeps) {}

  /** 当前 epoch 的待续跑 cleanup intent（有则说明上次切换中断）。 */
  get pending(): EpochCleanupIntent | undefined {
    const i = this.readIntent();
    return i ? { fromKeyEpoch: i.fromKeyEpoch, toKeyEpoch: i.toKeyEpoch } : undefined;
  }

  /**
   * epoch 切换清理：写 durable intent → （可选）存新 epoch DEK → 持久化新 snapshot →
   * 清旧 epoch recordMap/outbox → 删旧 epoch DEK → 清 intent，带可重放 cleanup intent；
   * 失败中途留下 intent，由 resume 完整幂等重放。intent 是第一个持久化动作，
   * 保证「新 DEK 落盘」等任何可存活步骤之前已有恢复标记（§7.4 崩溃窗口收敛）。
   * 删 DEK 只用 fromKeyEpoch（绝不误删新 epoch DEK）。参数 fail-closed：两个 epoch 须为
   * 规范 u64、toKeyEpoch > fromKeyEpoch、newSnapshot.keyEpoch === toKeyEpoch。
   */
  async reconcile(
    fromKeyEpoch: string,
    toKeyEpoch: string,
    newSnapshot: SyncStateSnapshot,
    newDek?: Uint8Array,
  ): Promise<void> {
    assertU64Decimal(fromKeyEpoch, 'fromKeyEpoch');
    assertU64Decimal(toKeyEpoch, 'toKeyEpoch');
    assertU64Decimal(newSnapshot.keyEpoch, 'newSnapshot.keyEpoch');
    if (!(BigInt(toKeyEpoch) > BigInt(fromKeyEpoch))) {
      throw new Error('epoch transition toKeyEpoch must be greater than fromKeyEpoch');
    }
    if (newSnapshot.keyEpoch !== toKeyEpoch) {
      throw new Error('epoch transition snapshot keyEpoch does not match toKeyEpoch');
    }
    const current = this.deps.currentEpoch();
    if (current !== undefined && current !== fromKeyEpoch) {
      throw new Error('epoch transition fromKeyEpoch mismatch');
    }
    this.deps.stopCoordinator();

    await this.writeIntent({ fromKeyEpoch, toKeyEpoch });
    if (newDek) await this.deps.dekStore.store(this.deps.userId, BigInt(toKeyEpoch), newDek);
    await this.deps.stateStore.setSnapshot(newSnapshot);
    // Gap-1（Option 1 严格清空）：进入新 epoch 前清除旧 epoch 的本地已同步实体，
    // 避免 destroy/reset/跨设备迁移后本地实体被当作「从未同步」而全量重推（重复/复活）。
    await this.clearEpoch(fromKeyEpoch);
    await this.clearIntent();

    this.deps.resetRuntime();
  }

  /** 撤销残留 cleanup intent（纯本地重置路径使用）。 */
  async clearPending(): Promise<void> {
    await this.clearIntent();
  }

  /** 在不可逆远端请求前落 durable intent（destroy/reset 的崩溃窗口恢复标记）。 */
  async writePending(intent: EpochCleanupIntent): Promise<void> {
    await this.writeIntent(intent);
  }

  /** 检测到 cleanup intent 时完整幂等重放（clear/delete 幂等、setSnapshot 等值不抛）。 */
  async resume(newSnapshot: SyncStateSnapshot): Promise<boolean> {
    const intent = this.readIntent();
    if (!intent) return false;
    assertU64Decimal(newSnapshot.keyEpoch, 'newSnapshot.keyEpoch');
    if (newSnapshot.keyEpoch === intent.toKeyEpoch) {
      // 提交成功：清理旧 epoch。
      await this.reconcile(intent.fromKeyEpoch, intent.toKeyEpoch, newSnapshot);
      return true;
    }
    if (newSnapshot.keyEpoch === intent.fromKeyEpoch) {
      // 提交前 journal：远端仍在旧 epoch（destroy/reset 未成功或响应丢失前已崩溃）——
      // 撤销 journal，继续正常解锁旧 epoch。
      await this.clearIntent();
      return false;
    }
    if (BigInt(newSnapshot.keyEpoch) > BigInt(intent.toKeyEpoch)) {
      // 复合故障死角：本地 journal {from→to} 残留期间，他设备已把远端进一步推进到 > to。
      // 视为「已提交且被超越」：from 与 to 两个 epoch 的旧 transition 都可能已持久化部分产物
      // （实体/DEK/map/outbox/unresolved），先 purge 映射实体、再清 store 与 DEK，最后撤销
      // journal，按远端实际 snapshot 继续（防止被越过时旧实体重推复活）。
      for (const epoch of [intent.fromKeyEpoch, intent.toKeyEpoch]) {
        await this.clearEpoch(epoch);
      }
      await this.clearIntent();
      return false;
    }
    throw new Error('resume snapshot keyEpoch does not match intent toKeyEpoch');
  }

  /**
   * 清除指定 epoch 的全部本地同步产物：已同步实体 + recordMap/outbox/unresolved + 持久化 DEK。
   * 依赖闭包规则（Gap-1 Option 1）：记录在本 epoch recordMap 里的实体（含 confirmed 与
   * pending 预留）都清除；删除 confirmed 父实体时 store 级联其依赖子树（连接 tombstone →
   * 级联其 query/folder）。未映射的独立实体与组织连接（org:）不在此映射内，天然保留。
   */
  async clearEpoch(epoch: string): Promise<void> {
    const entries = new RecordMapStore(this.deps.memento, this.deps.userId, epoch).list();
    for (const e of entries) {
      await this.deps.entities.remove({ type: e.type, localId: e.localId }, 'sync');
    }
    await new RecordMapStore(this.deps.memento, this.deps.userId, epoch).clear();
    await new PendingMutationStore(this.deps.memento, this.deps.userId, epoch).clear();
    await new UnresolvedRefStore(this.deps.memento, this.deps.userId, epoch).clear();
    await this.deps.dekStore.delete(this.deps.userId, BigInt(epoch));
  }

  private readIntent(): EpochCleanupIntent | undefined {
    const raw = this.deps.memento.get<unknown>(EpochTransitionCoordinator.EPOCH_CLEANUP_KEY + '.' + this.deps.userId);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'object' || raw === null) throw new Error('corrupt epoch cleanup intent');
    const o = raw as Record<string, unknown>;
    if (typeof o.fromKeyEpoch !== 'string' || typeof o.toKeyEpoch !== 'string') {
      throw new Error('corrupt epoch cleanup intent');
    }
    return { fromKeyEpoch: o.fromKeyEpoch, toKeyEpoch: o.toKeyEpoch };
  }

  private async writeIntent(i: EpochCleanupIntent): Promise<void> {
    await this.deps.memento.update(EpochTransitionCoordinator.EPOCH_CLEANUP_KEY + '.' + this.deps.userId, i);
  }

  private async clearIntent(): Promise<void> {
    await this.deps.memento.update(EpochTransitionCoordinator.EPOCH_CLEANUP_KEY + '.' + this.deps.userId, undefined);
  }
}