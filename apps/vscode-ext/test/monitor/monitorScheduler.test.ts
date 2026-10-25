import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorScheduler, type MonitorSchedulerDeps } from '../../src/monitor/monitorScheduler';
import type { MonitorPoint, MonitorTask } from '../../src/monitor/monitorTypes';

function task(over: Partial<MonitorTask> = {}): MonitorTask {
  return {
    id: 'm1', kind: 'rowCount', connId: 'c1', table: 'orders', intervalMs: 60_000,
    condition: { type: 'anyChange' }, status: 'running', createdAt: 0, consecutiveFailures: 0, ...over,
  };
}

function setup(over: Partial<MonitorSchedulerDeps> = {}, initial: MonitorTask[] = []) {
  let saved: MonitorTask[] = initial;
  const points: Array<{ id: string; point: MonitorPoint }> = [];
  const values: number[] = [];
  const deps: MonitorSchedulerDeps = {
    store: {
      loadTasks: async () => saved.map((t) => ({ ...t })),
      saveTasks: async (tasks) => { saved = tasks.map((t) => ({ ...t })); },
      appendPoint: async (id, point) => { points.push({ id, point }); },
      deleteHistory: vi.fn(async () => undefined),
    },
    run: vi.fn(async () => values.shift() ?? 0),
    canExecute: () => true,
    connectionValid: () => true,
    cooldownMs: () => 0,
    onHit: vi.fn(),
    onAutoPaused: vi.fn(),
    random: () => 0,
    ...over,
  };
  const scheduler = new MonitorScheduler(deps);
  return { scheduler, deps, points, values, saved: () => saved };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MonitorScheduler', () => {
  it('pauses every stored task on start and persists that', async () => {
    const { scheduler, saved, deps } = setup({}, [task(), task({ id: 'm2', status: 'error' })]);
    await scheduler.start();
    expect(scheduler.list().map((t) => t.status)).toEqual(['paused', 'paused']);
    expect(saved().every((t) => t.pausedReason === 'startup')).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('runs a baseline on add, then every interval, and notifies on change', async () => {
    const { scheduler, deps, values, points } = setup();
    values.push(10, 10, 12);
    await scheduler.add(task());
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(scheduler.get('m1')?.lastValue).toBe(10);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.onHit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.onHit).toHaveBeenCalledTimes(1);
    expect((deps.onHit as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(1)).toEqual([10, 12]);
    expect(points.map((p) => p.point.value)).toEqual([10, 10, 12]);
    scheduler.dispose();
  });

  it('skips a run while the previous one is still in flight', async () => {
    let release!: () => void;
    const { scheduler, points } = setup({ run: vi.fn(() => new Promise<number>((r) => { release = () => r(1); })) });
    const adding = scheduler.add(task());
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.runNow('m1');
    expect(points.at(-1)?.point.skipped).toBe(true);
    release();
    await adding;
    scheduler.dispose();
  });

  it('auto-pauses after three failures in a row and stops scheduling', async () => {
    const { scheduler, deps } = setup({ run: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    await scheduler.add(task());
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scheduler.get('m1')).toMatchObject({ status: 'paused', pausedReason: 'failures', consecutiveFailures: 3 });
    expect(deps.onAutoPaused).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.run).toHaveBeenCalledTimes(3);
  });

  it('does not execute in a window that does not hold the lock', async () => {
    const { scheduler, deps } = setup({ canExecute: () => false });
    await scheduler.add(task());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(deps.run).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it('pauses tasks whose connection was removed or changed', async () => {
    let valid = true;
    const { scheduler, deps } = setup({ connectionValid: () => valid });
    await scheduler.add(task());
    valid = false;
    await scheduler.revalidateConnections();
    expect(scheduler.get('m1')).toMatchObject({ status: 'paused', pausedReason: 'connectionChanged' });
    expect(deps.onAutoPaused).toHaveBeenCalledTimes(1);
    await scheduler.resume('m1');
    expect(scheduler.get('m1')?.status).toBe('paused');
  });

  it('resume schedules with jitter; pause stops; remove deletes history', async () => {
    const { scheduler, deps } = setup({ random: () => 1 }, [task()]);
    await scheduler.start();
    await scheduler.resume('m1');
    expect(scheduler.get('m1')?.pausedReason).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.run).not.toHaveBeenCalled(); // interval + 10% jitter
    await vi.advanceTimersByTimeAsync(6_000);
    expect(deps.run).toHaveBeenCalledTimes(1);
    await scheduler.pause('m1');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.run).toHaveBeenCalledTimes(1);
    await scheduler.remove('m1');
    expect(scheduler.list()).toEqual([]);
    expect(deps.store.deleteHistory).toHaveBeenCalledWith('m1');
  });

  it('resumeAll resumes only paused tasks', async () => {
    const { scheduler } = setup({}, [task(), task({ id: 'm2', table: 'b' })]);
    await scheduler.start();
    await scheduler.resumeAll();
    expect(scheduler.list().map((t) => t.status)).toEqual(['running', 'running']);
    expect(scheduler.runningCount()).toBe(2);
    scheduler.dispose();
  });
});

describe('MonitorScheduler across windows', () => {
  it('a non-owner start does not rewrite tasks.json', async () => {
    const { scheduler, deps } = setup({ isOwner: () => false }, [task()]);
    const saveTasks = vi.spyOn(deps.store, 'saveTasks');
    await scheduler.start();
    expect(scheduler.get('m1')?.status).toBe('running');
    expect(saveTasks).not.toHaveBeenCalled();
  });

  it('a non-owner cannot add, pause, resume or remove, and never runs', async () => {
    const { scheduler, deps, saved } = setup({ isOwner: () => false }, [task()]);
    await scheduler.start();
    await expect(scheduler.add(task({ id: 'm2' }))).rejects.toMatchObject({ name: 'MonitorNotOwnerError' });
    await expect(scheduler.pause('m1')).rejects.toMatchObject({ name: 'MonitorNotOwnerError' });
    await expect(scheduler.resume('m1')).rejects.toMatchObject({ name: 'MonitorNotOwnerError' });
    await expect(scheduler.resumeAll()).rejects.toMatchObject({ name: 'MonitorNotOwnerError' });
    await expect(scheduler.remove('m1')).rejects.toMatchObject({ name: 'MonitorNotOwnerError' });
    await scheduler.revalidateConnections();
    await scheduler.runNow('m1');
    expect(deps.run).not.toHaveBeenCalled();
    expect(saved().map((t) => t.id)).toEqual(['m1']);
    expect(saved()[0]!.status).toBe('running');
  });

  it('a non-owner reload picks up changes written by the owner window', async () => {
    const { scheduler, deps } = setup({ isOwner: () => false }, [task()]);
    await scheduler.start();
    await deps.store.saveTasks([task({ lastValue: 42 }), task({ id: 'm2', table: 'b' })]);
    await scheduler.reload();
    expect(scheduler.list().map((t) => t.id)).toEqual(['m1', 'm2']);
    expect(scheduler.get('m1')?.lastValue).toBe(42);
  });

  it('takeOver reloads from disk (latest cursor) and pauses everything', async () => {
    let owner = false;
    const { scheduler, deps, saved } = setup({ isOwner: () => owner }, [task({ kind: 'newRows', cursorValue: '5' })]);
    await scheduler.start();
    // 原执行窗口推进了游标后关闭
    await deps.store.saveTasks([task({ kind: 'newRows', cursorValue: '9' })]);
    owner = true;
    await scheduler.takeOver();
    expect(scheduler.get('m1')).toMatchObject({ status: 'paused', pausedReason: 'handover' });
    expect(scheduler.get('m1')?.cursorValue).toBe('9');
    expect(saved()[0]!.pausedReason).toBe('handover');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('relinquish stops local timers', async () => {
    let owner = true;
    const { scheduler, deps } = setup({ isOwner: () => owner });
    await scheduler.add(task());
    expect(deps.run).toHaveBeenCalledTimes(1);
    owner = false;
    scheduler.relinquish();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.run).toHaveBeenCalledTimes(1);
  });
});

describe('MonitorScheduler with structured results', () => {
  it('stores metric values and cursor state, keeps new rows in memory only', async () => {
    const outputs = [
      { value: 0, cursor: { value: '10', seen: ['["10"]'] }, rows: [], more: false },
      { value: 2, cursor: { value: '12', seen: ['["12"]'] }, rows: [{ id: 11, secret: 'x' }, { id: 12, secret: 'y' }], more: false },
    ];
    const { scheduler, points, saved } = setup({ run: vi.fn(async () => outputs.shift()!) });
    await scheduler.add(task({ kind: 'newRows', cursorColumn: 'id', primaryKey: ['id'], condition: { type: 'increaseBy', value: 1 } }));
    await scheduler.runNow('m1');
    expect(scheduler.get('m1')).toMatchObject({ lastValue: 2, cursorValue: '12', cursorSeen: ['["12"]'] });
    expect(scheduler.latestRows('m1')?.rows).toHaveLength(2);
    // Row contents are neither persisted in tasks.json nor in the history file.
    expect(JSON.stringify(saved())).not.toContain('secret');
    expect(JSON.stringify(points)).not.toContain('secret');
    await scheduler.remove('m1');
    expect(scheduler.latestRows('m1')).toBeUndefined();
  });

  it('notifies new rows against the threshold, not against the previous count', async () => {
    const outputs = [{ value: 0 }, { value: 3 }, { value: 3 }];
    const { scheduler, deps } = setup({ run: vi.fn(async () => outputs.shift()!) });
    await scheduler.add(task({ kind: 'newRows', condition: { type: 'increaseBy', value: 3 } }));
    await scheduler.runNow('m1');
    await scheduler.runNow('m1');
    expect(deps.onHit).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('records a NULL watched metric without notifying', async () => {
    const outputs = [{ value: 5, values: { lag: 5 } }, { value: null, values: { lag: null } }];
    const { scheduler, deps, points } = setup({ run: vi.fn(async () => outputs.shift()!) });
    await scheduler.add(task({ kind: 'metric', sql: 'SELECT 1 AS lag', watchColumn: 'lag', condition: { type: 'anyChange' } }));
    await scheduler.runNow('m1');
    expect(deps.onHit).not.toHaveBeenCalled();
    expect(scheduler.get('m1')).toMatchObject({ lastValue: 5, lastValues: { lag: null } });
    expect(points.at(-1)?.point).toMatchObject({ values: { lag: null } });
    expect(points.at(-1)?.point.value).toBeUndefined();
    scheduler.dispose();
  });
});
