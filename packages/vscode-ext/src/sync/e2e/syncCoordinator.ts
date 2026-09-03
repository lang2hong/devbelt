import type { Disposable } from '../../utils/event';
import type { ConnectionStore } from '../../connection/connectionStore';
import type { SyncEngine, SyncRunResult } from './syncEngine';
import type { SyncMutator } from './syncMutator';

/**
 * 本地变更协调器（任务 3）。
 *
 * 订阅 `ConnectionStore.onChanged`，仅 `source==='user'` 触发（`'sync'` 是入站 applyRecord
 * 回写，忽略以阻断回环）。回调不 await sync（不阻塞事件源），经 trailing debounce 合并批量
 * onChanged；触发的 sync 复用同一 `SyncEngine` 实例（否则 inflight 单飞失效）。
 *
 * 串行协调：mutation 生成（reconcile 入 outbox）→ sync（push+确认+pull）→ 确认后重对账
 * （drain 循环，捕获「put 确认后再删」/「确认后二次编辑」等由确认驱动的后续 mutation）。
 */
export class SyncCoordinator {
  private static readonly DEBOUNCE_MS = 250;
  private static readonly MAX_DRAIN_ROUNDS = 5;

  private debounceTimer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  private subscription?: Disposable;
  private _lastError?: string;
  private _lastRun?: SyncRunResult;

  /** 最近一次后台协调失败的原因（不含秘密）；不阻断链，后续 user 变更仍能重调度。 */
  get lastError(): string | undefined {
    return this._lastError;
  }

  /** 最近一次后台 sync 的结构化结果（terminal/conflict/stalled 不丢）。成功轮次被 drain 覆盖。 */
  get lastRun(): SyncRunResult | undefined {
    return this._lastRun;
  }

  constructor(
    private readonly store: ConnectionStore,
    private readonly mutator: SyncMutator,
    private readonly engine: SyncEngine,
  ) {}

  start(): void {
    if (this.subscription) return; // 幂等：已订阅不重复订阅
    this.subscription = this.store.onChanged((source) => {
      if (source !== 'user') return;
      this.schedule();
    });
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.subscription?.dispose();
    this.subscription = undefined;
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.chain = this.chain.then(() => this.drain()).catch((err) => {
        this._lastError = describe(err);
      });
      void this.chain;
    }, SyncCoordinator.DEBOUNCE_MS);
  }

  private async drain(): Promise<void> {
    // 成功轮次清空上次失败：新一轮开始即清，若本轮抛错由 schedule 的 catch 重写。
    this._lastError = undefined;
    for (let i = 0; i < SyncCoordinator.MAX_DRAIN_ROUNDS; i++) {
      const { generated } = await this.mutator.reconcile();
      const result = await this.engine.sync();
      this._lastRun = result;
      if (result.stage !== 'ok') return;
      if (generated === 0) return;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}