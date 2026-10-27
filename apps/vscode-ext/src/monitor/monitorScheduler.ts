import {
  applyFailure,
  applySuccess,
  clampInterval,
  jitterDelay,
  pauseAllOnStartup,
  type MonitorPoint,
  type MonitorRunResult,
  type MonitorTask,
} from './monitorTypes';

/**
 * 非执行窗口（没拿到锁）试图修改任务时抛出：任务状态只由持锁窗口写，
 * 否则多个窗口各自的内存副本会互相覆盖 tasks.json。
 */
export class MonitorNotOwnerError extends Error {
  constructor() {
    super('monitor tasks are owned by another VS Code window');
    this.name = 'MonitorNotOwnerError';
  }
}

/** 执行结果：数值 / 多列 / 游标，加上只放内存的新增行。旧调用方可以只返回数字。 */
export type MonitorRunOutput = number | (MonitorRunResult & { rows?: Array<Record<string, unknown>>; more?: boolean });

/** 调度器依赖（测试注入 fake 实现与 fake timers）。 */
export interface MonitorSchedulerDeps {
  store: {
    loadTasks(): Promise<MonitorTask[]>;
    saveTasks(tasks: readonly MonitorTask[]): Promise<void>;
    appendPoint(taskId: string, point: MonitorPoint): Promise<void>;
    deleteHistory(taskId: string): Promise<void>;
  };
  run(task: MonitorTask): Promise<MonitorRunOutput>;
  /** 本窗口是否持有执行锁；不持锁时只显示、不执行。 */
  canExecute(): boolean;
  /**
   * 本窗口是否拥有任务（持锁）：只有拥有者能修改任务并写 tasks.json。
   * 缺省视为拥有（单窗口 / 测试）。
   */
  isOwner?(): boolean;
  /** 连接仍存在且指纹未变；否则任务暂停。 */
  connectionValid(task: MonitorTask): boolean;
  cooldownMs(): number;
  onHit?(task: MonitorTask, previous: number | undefined, value: number): void;
  /** 每次成功执行后（AI Chat 抽屉实时刷新用）。 */
  onRun?(task: MonitorTask): void;
  /** 一次检查开始时（界面显示「检查中」）。 */
  onRunStart?(): void;
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
  /** 下一次计划执行时间（界面显示「下次 X 后」）。 */
  private readonly nextRuns = new Map<string, number>();
  /** B：每个任务最近一次的新增行（只放内存，不落盘）。 */
  private readonly recentRows = new Map<string, { at: number; rows: Array<Record<string, unknown>>; more: boolean }>();
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

  /**
   * 启动：拥有者把所有任务置为暂停并写回；非拥有者只读取用于显示，不写文件
   * （否则第二个窗口启动会把第一个窗口正在运行的任务全部改成暂停）。
   */
  async start(): Promise<void> {
    const loaded = await this.deps.store.loadTasks();
    if (!this.isOwner()) {
      this.tasks = loaded;
      this.deps.onChanged?.(this.tasks);
      return;
    }
    this.tasks = pauseAllOnStartup(loaded);
    if (loaded.some((t, i) => t.status !== this.tasks[i]?.status)) await this.persist();
    else this.deps.onChanged?.(this.tasks);
  }

  /** 非拥有者定期从磁盘刷新显示（拥有者以内存为准，不需要）。 */
  async reload(): Promise<void> {
    if (this.isOwner()) return;
    const loaded = await this.deps.store.loadTasks();
    if (JSON.stringify(loaded) === JSON.stringify(this.tasks)) return;
    this.tasks = loaded;
    this.deps.onChanged?.(this.tasks);
  }

  /**
   * 接手执行（原执行窗口已关闭，锁过期）：以磁盘为准重新加载（游标等状态是原窗口最新写入的），
   * 并把所有任务暂停——不在用户没看到的情况下继续查询，由用户在本窗口继续。
   */
  async takeOver(): Promise<number> {
    if (!this.isOwner()) return 0;
    for (const id of [...this.timers.keys()]) this.unschedule(id);
    const loaded = await this.deps.store.loadTasks();
    let paused = 0;
    this.tasks = loaded.map((t) => {
      if (t.status === 'paused') return t;
      paused += 1;
      return { ...t, status: 'paused', pausedReason: 'handover' };
    });
    await this.persist();
    return paused;
  }

  /** 失去执行权（另一窗口接手）：停掉本地计时器，之后只显示。 */
  relinquish(): void {
    for (const id of [...this.timers.keys()]) this.unschedule(id);
  }

  isOwner(): boolean {
    return this.deps.isOwner ? this.deps.isOwner() : true;
  }

  private assertOwner(): void {
    if (!this.isOwner()) throw new MonitorNotOwnerError();
  }

  list(): readonly MonitorTask[] {
    return this.tasks;
  }

  get(id: string): MonitorTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** 下一次计划执行的时间戳；没有计时器（暂停 / 已释放）时为空。 */
  nextRun(id: string): number | undefined {
    return this.nextRuns.get(id);
  }

  /** 这一次是否正在执行。 */
  isExecuting(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** B：最近一次新增的行（内存；VS Code 重启后为空）。 */
  latestRows(id: string): { at: number; rows: Array<Record<string, unknown>>; more: boolean } | undefined {
    return this.recentRows.get(id);
  }

  runningCount(): number {
    return this.tasks.filter((t) => t.status === 'running' || t.status === 'error').length;
  }

  /** 新建任务并立即运行一次（基线），之后按间隔调度。 */
  async add(task: MonitorTask): Promise<void> {
    this.assertOwner();
    this.tasks = [...this.tasks, { ...task, intervalMs: clampInterval(task.intervalMs), status: 'running', consecutiveFailures: 0 }];
    await this.persist();
    await this.runNow(task.id);
    this.schedule(task.id, false);
  }

  async resume(id: string): Promise<void> {
    this.assertOwner();
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
    this.assertOwner();
    for (const task of [...this.tasks]) if (task.status === 'paused') await this.resume(task.id);
  }

  /** 修改间隔 / 提醒条件（只有拥有者）。间隔变化后按新间隔重新计时。 */
  async edit(id: string, patch: { intervalMs?: number; condition?: MonitorTask['condition'] }): Promise<void> {
    this.assertOwner();
    const task = this.get(id);
    if (!task) return;
    const intervalMs = clampInterval(patch.intervalMs ?? task.intervalMs);
    const next: MonitorTask = { ...task, intervalMs, ...(patch.condition ? { condition: patch.condition } : {}) };
    await this.replace(next);
    if (next.status === 'running' || next.status === 'error') this.schedule(id, false);
  }

  async pause(id: string, reason: 'user' | 'accountSwitch' = 'user'): Promise<void> {
    this.assertOwner();
    this.unschedule(id);
    await this.update(id, { status: 'paused', pausedReason: reason });
  }

  async remove(id: string): Promise<void> {
    this.assertOwner();
    this.unschedule(id);
    this.recentRows.delete(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.persist();
    await this.deps.store.deleteHistory(id);
  }

  /** 连接被删除 / 修改：相关运行中任务暂停。 */
  async revalidateConnections(): Promise<void> {
    if (!this.isOwner()) return;
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
    if (!this.deps.canExecute() || !this.isOwner()) return;
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
    this.deps.onRunStart?.();
    const started = this.now();
    try {
      const raw = await this.deps.run(task);
      const output = typeof raw === 'number' ? { value: raw } : raw;
      const current = this.get(id);
      // 执行期间失去执行权（另一窗口接手）：结果丢弃，不写回。
      if (!current || this.disposed || !this.isOwner()) return;
      const outcome = applySuccess(current, output.value, this.now(), this.deps.cooldownMs(), {
        ...(output.values ? { values: output.values } : {}),
        ...(output.cursor ? { cursor: output.cursor } : {}),
      });
      await this.replace(outcome.task);
      if (typeof raw !== 'number' && raw.rows) {
        if (raw.rows.length > 0) this.recentRows.set(id, { at: started, rows: raw.rows, more: raw.more === true });
      }
      await this.deps.store.appendPoint(id, {
        at: started,
        ...(output.value !== null ? { value: output.value } : {}),
        ...(output.values ? { values: output.values } : {}),
        durationMs: this.now() - started,
      });
      this.deps.onRun?.(outcome.task);
      if (outcome.notify && output.value !== null) this.deps.onHit?.(outcome.task, outcome.previous, output.value);
    } catch (err) {
      const current = this.get(id);
      if (!current || this.disposed || !this.isOwner()) return;
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
      this.nextRuns.delete(id);
      void this.tick(id);
    }, delay);
    this.timers.set(id, handle);
    this.nextRuns.set(id, this.now() + delay);
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
    this.nextRuns.delete(id);
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

  /** 只有拥有者写 tasks.json（兜底：任何路径漏了拥有者检查也不会覆盖另一窗口的状态）。 */
  private async persist(): Promise<void> {
    if (this.isOwner()) await this.deps.store.saveTasks(this.tasks);
    this.deps.onChanged?.(this.tasks);
  }
}
