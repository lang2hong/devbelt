import type { Disposable } from '../../utils/event.js';
import type { ConnectionStore } from '../../connection/connectionStore.js';
import { SYNC_CANCELLED_REASON } from './syncEngine.js';
import type { SyncEngine, SyncRunResult, RepairOutcome, FindingsReport } from './syncEngine.js';
import type { SyncMutator } from './syncMutator.js';

/**
 * 本地变更协调器（任务 3）。
 *
 * 订阅 `ConnectionStore.onChanged`，仅 `source==='user'` 触发（`'sync'` 是入站 applyRecord
 * 回写，忽略以阻断回环）。回调不 await sync（不阻塞事件源），经 trailing debounce 合并批量
 * onChanged；触发的 sync 复用同一 `SyncEngine` 实例（否则 inflight 单飞失效）。
 *
 * 串行协调：mutation 生成（reconcile 入 outbox）→ sync（push+确认+pull）→ 确认后重对账
 * （drain 循环，捕获「put 确认后再删」/「确认后二次编辑」等由确认驱动的后续 mutation）。
 *
 * 失败恢复（任务 B2）：`stage==='error'` 视为临时性失败，按指数退避（base 1s ×2、上限 30s）
 * 自动重试；`ok` 复位退避。`stage∈{conflict,terminal,epoch-mismatch}` 或 `result.stalled`
 * 属非临时状态，停止自动重试并令 `stalled` 可观测（不无限请求，等用户操作或生命周期流程）。
 */
export interface SyncCoordinatorOptions {
  /** 每个 drain 轮结束（含失败）后回调，供上层刷树/更新状态栏；回调异常不阻断同步链。 */
  onSettled?: (result: SyncRunResult | undefined) => void;
  /**
   * 自动同步开关（按机器）。返回 false 时：`onChanged` 不再自动触发后台同步；显式
   * `scheduleNow`/`runNow`/分相仍可用。缺省视为开启（兼容既有调用方）。
   */
  autoSyncEnabled?: () => boolean;
  /** 一轮同步进入时回调（含手动/后台）；供状态栏显示"进行中"。 */
  onSyncStart?: (phase: 'pull' | 'push' | 'both') => void;
}

export class SyncCoordinator {
  private static readonly DEBOUNCE_MS = 250;
  private static readonly MAX_DRAIN_ROUNDS = 5;
  private static readonly RETRY_BASE_MS = 1000;
  private static readonly RETRY_MAX_MS = 30000;

  private debounceTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  private subscription?: Disposable;
  private stopped = false;
  private _lastError?: string;
  private _lastRun?: SyncRunResult;
  private _stalled = false;
  private retryDelay = SyncCoordinator.RETRY_BASE_MS;

  /** 最近一次后台协调失败的原因（不含秘密）；不阻断链，后续 user 变更仍能重调度。 */
  get lastError(): string | undefined {
    return this._lastError;
  }

  /** 最近一次后台 sync 的结构化结果（terminal/conflict/stalled 不丢）。成功轮次被 drain 覆盖。 */
  get lastRun(): SyncRunResult | undefined {
    return this._lastRun;
  }

  /** 是否因 terminal/conflict/epoch-mismatch/paging-stalled 已停止自动重试。 */
  get stalled(): boolean {
    return this._stalled;
  }

  /** 是否正处于失败退避重试的等待期（retryTimer 已排）。 */
  get retrying(): boolean {
    return this.retryTimer !== undefined;
  }

  constructor(
    private readonly store: ConnectionStore,
    private readonly mutator: SyncMutator,
    private readonly engine: SyncEngine,
    private readonly options: SyncCoordinatorOptions = {},
  ) {}

  start(): void {
    if (this.subscription) return; // 幂等：已订阅不重复订阅
    this.stopped = false;
    // 重入（lock→unlock 复用同一 coordinator）时重置懒状态，确保退避/首次同步从干净起点开始。
    this._stalled = false;
    this._lastError = undefined;
    this.retryDelay = SyncCoordinator.RETRY_BASE_MS;
    this.clearRetry();
    // 上一次 stopAndDrain 取消过引擎：重新启动时必须放开，否则之后每一轮都立刻被取消。
    this.engine.resume?.();
    this.subscription = this.store.onChanged((source) => {
      if (source !== 'user') return;
      if (!this.autoSyncOn()) return;
      this.schedule();
    });
  }

  /** 自动同步是否开启（缺省开启，兼容未注入谓词的调用方）。 */
  private autoSyncOn(): boolean {
    return this.options.autoSyncEnabled ? this.options.autoSyncEnabled() : true;
  }

  /** 同步进入回调（异常吞掉，绝不影响同步）。 */
  private emitSyncStart(phase: 'pull' | 'push' | 'both'): void {
    try { this.options.onSyncStart?.(phase); } catch { /* 状态回调异常不影响同步 */ }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.clearRetry();
    this.subscription?.dispose();
    this.subscription = undefined;
  }

  /**
   * 停止并等待在途轮次真正结束（epoch 切换用）。
   *
   * 单独的 `stop()` 只清定时器和订阅，已经在跑的一轮会继续往本地写；epoch 清理之后它还在
   * 应用旧 epoch 的记录，会把刚清掉的实体建回来。这里先取消引擎，再等当前链收尾，
   * 最多等 `timeoutMs`：网络卡死时不能把 destroy/reset 一起拖死。
   */
  async stopAndDrain(timeoutMs = 15_000): Promise<void> {
    this.stop();
    this.engine.cancel?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([this.chain, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 用户显式请求的同步：复用同一串行链，避免和 debounce 轮次并发。失败返回调用方。 */
  async runNow(): Promise<SyncRunResult | undefined> {
    let failure: unknown;
    const run = this.chain.then(async () => {
      this.emitSyncStart('both');
      return this.drain()
        .then((result) => {
          this.notify(result);
          if (!isCancelled(result)) this.maybeRetry(result);
        })
        .catch((err) => {
          failure = err;
          this._lastError = describe(err);
          this.notify(undefined);
        });
    });
    this.chain = run.catch(() => {});
    await run;
    if (failure) throw failure;
    return this._lastRun;
  }

  /** 显式 pull：仅拉取远端 feed（不走 outbox 重放），复用同一串行链。 */
  async pullNow(): Promise<SyncRunResult | undefined> {
    return this.runPhase('pull');
  }

  /** 显式 push：先生成本地变更 mutation，再仅重放出站 outbox。 */
  async pushNow(): Promise<SyncRunResult | undefined> {
    return this.runPhase('push', true);
  }

  /** 体检检测（只读，零写入）：逐条列出本地与云端的不一致。经串行链执行，避免与同步并发读写映射。 */
  async findingsNow(): Promise<FindingsReport> {
    const run = this.chain.then(() => this.engine.inspectFindings());
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 修复用户选择的不一致项（缺省全部；方向由用户选择：cloud=按云端，local=用本机覆盖云端）。经串行链执行。 */
  async repairFindingsNow(ids?: string[], direction?: 'cloud' | 'local' | 'merge'): Promise<RepairOutcome> {
    const run = this.chain.then(() => this.engine.repairFindings(ids, direction));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 分相执行：串行入链（避免与 debounce 轮次并发），通知/退避与 runNow 一致。 */
  private async runPhase(phase: 'pull' | 'push', reconcile = false): Promise<SyncRunResult | undefined> {
    let failure: unknown;
    const run = this.chain.then(async () => {
      this.emitSyncStart(phase);
      try {
        let skippedOutbound = 0;
        let skippedOutboundReason: string | undefined;
        if (reconcile) {
          const reconciled = await this.mutator.reconcile();
          skippedOutbound = reconciled.skipped?.length ?? 0;
          skippedOutboundReason = reconciled.skipped?.[0]?.reason;
        }
        const result = await this.engine.syncPhase(phase);
        if (skippedOutbound) {
          result.skippedOutbound = skippedOutbound;
          if (skippedOutboundReason) result.skippedOutboundReason = skippedOutboundReason;
        }
        // 被取消的运行不是结果：不覆盖 lastRun、不改 stalled/退避（但仍通知，好让界面清掉转圈）。
        if (!isCancelled(result)) this._lastRun = result;
        this.notify(result);
        // 显式 pull/push 是独立动作：**只更新状态、不排后台重试**（避免重试走 drain() 的 both
        // 全量而隐式触发对方动作）。成功清 stalled/退避、冲突置 stalled 仍要执行。
        if (!isCancelled(result)) this.updateRunState(result);
      } catch (err) {
        failure = err;
        this._lastError = describe(err);
        this.notify(undefined);
      }
    });
    this.chain = run.catch(() => {});
    await run;
    if (failure) throw failure;
    return this._lastRun;
  }

  /** 立即入链同步（无 debounce、无幂等）；错误经 lastError 与退避体现，不向上抛。 */
  scheduleNow(): void {
    if (this.stopped) return;
    this.enqueue();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.enqueue();
    }, SyncCoordinator.DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  private enqueue(): void {
    this.chain = this.chain.then(() => this.run()).catch(() => {});
    void this.chain;
  }

  /** 后台轮：跑一轮 drain，永不拒绝（错误记录 + 退避）；结束统一 notify。 */
  private async run(): Promise<void> {
    this.emitSyncStart('both');
    try {
      const result = await this.drain();
      this.notify(result);
      if (!isCancelled(result)) this.maybeRetry(result);
    } catch (err) {
      this._lastError = describe(err);
      this.notify(undefined);
      this.armRetry();
    }
  }

  /** 一轮 drain：成功轮次清空上次失败；reconcile 产 mutation 后 sync，非 ok 即返回。 */
  private async drain(): Promise<SyncRunResult | undefined> {
    this._lastError = undefined;
    let last: SyncRunResult | undefined;
    // 跨轮**累加**：第 1 轮推送、第 2 轮无 generated 时，若用第 2 轮结果覆盖，会把已推送/已落地数丢掉，
    // 立即同步就误报「无变更」。
    const acc = { applied: 0, pushed: 0, changes: 0, ignoredTombstone: 0, skippedRemote: 0, skippedEntitlement: 0, skippedUnsupported: 0, skippedDisabled: 0 };
    const merge = (r: SyncRunResult): SyncRunResult => ({
      ...r,
      applied: acc.applied,
      pushed: acc.pushed,
      changes: acc.changes,
      ignoredTombstone: acc.ignoredTombstone,
      skippedRemote: acc.skippedRemote,
      skippedEntitlement: acc.skippedEntitlement,
      skippedUnsupported: acc.skippedUnsupported,
      skippedDisabled: acc.skippedDisabled,
    });
    for (let i = 0; i < SyncCoordinator.MAX_DRAIN_ROUNDS; i++) {
      const { generated, skipped } = await this.mutator.reconcile();
      const result = await this.engine.sync();
      if (skipped?.length) {
        // 各轮同批，覆盖即等于该批总数（未来跨轮去重再改累加）
        result.skippedOutbound = skipped.length;
        const reason = skipped[0]?.reason;
        if (reason) result.skippedOutboundReason = reason;
      }
      acc.applied += result.applied ?? 0;
      acc.pushed += result.pushed ?? 0;
      acc.changes += result.changes ?? 0;
      acc.ignoredTombstone += result.ignoredTombstone ?? 0;
      acc.skippedRemote += result.skippedRemote ?? 0;
      acc.skippedEntitlement += result.skippedEntitlement ?? 0;
      acc.skippedUnsupported += result.skippedUnsupported ?? 0;
      acc.skippedDisabled += result.skippedDisabled ?? 0;
      const merged = merge(result);
      if (!isCancelled(result)) this._lastRun = merged;
      last = merged;
      if (result.stage !== 'ok') return merged;
      if (generated === 0) return merged;
    }
    return last;
  }

  /** 仅更新状态：成功复位退避并清 stalled；冲突/终态置 stalled。不启动重试。 */
  private updateRunState(result: SyncRunResult | undefined): void {
    if (!result) return;
    if (result.stage === 'ok') {
      this._stalled = false;
      this.clearRetry();
      this.retryDelay = SyncCoordinator.RETRY_BASE_MS;
      return;
    }
    if (result.stage === 'error' && !result.stalled) {
      this._stalled = false;
      return;
    }
    this._stalled = true;
    this.clearRetry();
  }

  /** 后台轮：更新状态 + 按需启动退避重试（显式 pull/push 只用 updateRunState，不启动重试）。 */
  private maybeRetry(result: SyncRunResult | undefined): void {
    this.updateRunState(result);
    if (result?.stage === 'error' && !result.stalled) this.armRetry();
  }

  private armRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, SyncCoordinator.RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) this.enqueue();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private notify(result: SyncRunResult | undefined): void {
    try {
      this.options.onSettled?.(result);
    } catch {
      // 上层回调异常不阻断同步链
    }
  }
}

function isCancelled(result: SyncRunResult | undefined): boolean {
  return result?.reason === SYNC_CANCELLED_REASON;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}