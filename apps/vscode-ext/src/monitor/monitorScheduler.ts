import {
  applyFailure,
  applySuccess,
  clampInterval,
  jitterDelay,
  pauseAllOnStartup,
  type MonitorPoint,
  type MonitorTask,
} from './monitorTypes';

/** 调度器依赖（测试注入 fake 实现与 fake timers）。 */
export interface MonitorSchedulerDeps {
  store: {
    loadTasks(): Promise<MonitorTask[]>;
    saveTasks(tasks: readonly MonitorTask[]): Promise<void>;
    appendPoint(taskId: string, point: MonitorPoint): Promise<void>;
    deleteHistory(taskId: string): Promise<void>;
  };
  run(task: MonitorTask): Promise<number>;
  /** 本窗口是否持有执行锁；不持锁时只显示、不执行。 */
  canExecute(): boolean;
  /** 连接仍存在且指纹未变；否则任务暂停。 */
  connectionValid(task: MonitorTask): boolean;
  cooldownMs(): number;
  onHit?(task: MonitorTask, previous: number | undefined, value: number): void;
  onAutoPaused?(task: MonitorTask): void;
  onChanged?(tasks: readonly MonitorTask[]): void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * 监控调度器：每个运行中任务一个计时器（首次带 0–10% 抖动），上一次没结束则跳过；
 * 执行结果更新任务状态、写历史、触发通知；连续失败自动暂停。
 *
 * 启动时所有任务置为暂停——用户不在场时不自动查询数据库。
 */
export class MonitorScheduler {
  private tasks: MonitorTask[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private disposed = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly deps: MonitorSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  }

  async start(): Promise<void> {
    const loaded = await this.deps.store.loadTasks();
    this.tasks = pauseAllOnStartup(loaded);
    if (loaded.some((t, i) => t.status !== this.tasks[i]?.status)) await this.persist();
    else this.deps.onChanged?.(this.tasks);
  }

  list(): readonly MonitorTask[] {
    return this.tasks;
  }

  get(id: string): MonitorTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  runningCount(): number {
    return this.tasks.filter((t) => t.status === 'running' || t.status === 'error').length;
  }

  /** 新建任务并立即运行一次（基线），之后按间隔调度。 */
  async add(task: MonitorTask): Promise<void> {
    this.tasks = [...this.tasks, { ...task, intervalMs: clampInterval(task.intervalMs), status: 'running', consecutiveFailures: 0 }];
    await this.persist();
    await this.runNow(task.id);
    this.schedule(task.id, false);
  }

  async resume(id: string): Promise<void> {
    const task = this.get(id);
    if (!task || task.status === 'running') return;
    if (!this.deps.connectionValid(task)) {
      await this.update(id, { status: 'paused', pausedReason: 'connectionChanged' });
      this.deps.onAutoPaused?.(this.get(id)!);
      return;
    }
    await this.update(id, { status: 'running', consecutiveFailures: 0, pausedReason: undefined });
    this.schedule(id, true);
  }

  async resumeAll(): Promise<void> {
    for (const task of [...this.tasks]) if (task.status === 'paused') await this.resume(task.id);
  }

  async pause(id: string): Promise<void> {
    this.unschedule(id);
    await this.update(id, { status: 'paused', pausedReason: 'user' });
  }

  async remove(id: string): Promise<void> {
    this.unschedule(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.persist();
    await this.deps.store.deleteHistory(id);
  }

  /** 连接被删除 / 修改：相关运行中任务暂停。 */
  async revalidateConnections(): Promise<void> {
    for (const task of [...this.tasks]) {
      if (task.status === 'paused' || this.deps.connectionValid(task)) continue;
      this.unschedule(task.id);
      await this.update(task.id, { status: 'paused', pausedReason: 'connectionChanged' });
      this.deps.onAutoPaused?.(this.get(task.id)!);
    }
  }

  /**
   * 立即执行一次（用户点「立即运行」或新建任务的基线）。
   * 上一次还没结束时跳过并记一个 skipped 点；不持锁时不执行。
   */
  async runNow(id: string): Promise<void> {
    const task = this.get(id);
    if (!task || this.disposed) return;
    if (!this.deps.canExecute()) return;
    if (this.inFlight.has(id)) {
      await this.deps.store.appendPoint(id, { at: this.now(), durationMs: 0, skipped: true });
      return;
    }
    if (!this.deps.connectionValid(task)) {
      this.unschedule(id);
      await this.update(id, { status: 'paused', pausedReason: 'connectionChanged' });
      this.deps.onAutoPaused?.(this.get(id)!);
      return;
    }
    this.inFlight.add(id);
    const started = this.now();
    try {
      const value = await this.deps.run(task);
      const current = this.get(id);
      if (!current || this.disposed) return;
      const outcome = applySuccess(current, value, this.now(), this.deps.cooldownMs());
      await this.replace(outcome.task);
      await this.deps.store.appendPoint(id, { at: started, value, durationMs: this.now() - started });
      if (outcome.notify) this.deps.onHit?.(outcome.task, outcome.previous, value);
    } catch (err) {
      const current = this.get(id);
      if (!current || this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      const outcome = applyFailure(current, message, this.now());
      await this.replace(outcome.task);
      await this.deps.store.appendPoint(id, { at: started, durationMs: this.now() - started, error: outcome.task.lastError });
      if (outcome.paused) {
        this.unschedule(id);
        this.deps.onAutoPaused?.(outcome.task);
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.timers.keys()]) this.unschedule(id);
  }

  private schedule(id: string, withJitter: boolean): void {
    this.unschedule(id);
    const task = this.get(id);
    if (!task || this.disposed || (task.status !== 'running' && task.status !== 'error')) return;
    const delay = task.intervalMs + (withJitter ? jitterDelay(task.intervalMs, this.random) : 0);
    const handle = this.setTimer(() => {
      this.timers.delete(id);
      void this.tick(id);
    }, delay);
    this.timers.set(id, handle);
  }

  private async tick(id: string): Promise<void> {
    await this.runNow(id);
    const task = this.get(id);
    if (task && (task.status === 'running' || task.status === 'error')) this.schedule(id, false);
  }

  private unschedule(id: string): void {
    const handle = this.timers.get(id);
    if (handle) this.clearTimer(handle);
    this.timers.delete(id);
  }

  private async update(id: string, patch: Partial<MonitorTask>): Promise<void> {
    const current = this.get(id);
    if (!current) return;
    const next: MonitorTask = { ...current, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    }
    await this.replace(next);
  }

  private async replace(task: MonitorTask): Promise<void> {
    this.tasks = this.tasks.map((t) => (t.id === task.id ? task : t));
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.deps.store.saveTasks(this.tasks);
    this.deps.onChanged?.(this.tasks);
  }
}
