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
