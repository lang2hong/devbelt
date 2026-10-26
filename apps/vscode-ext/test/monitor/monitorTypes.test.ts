import { describe, expect, it } from 'vitest';
import {
  applyFailure,
  applySuccess,
  canNotify,
  checkCanCreate,
  clampInterval,
  connectionFingerprint,
  defaultIntervalFor,
  estimatedRowsFromDescription,
  evaluateCondition,
  FAILURES_BEFORE_PAUSE,
  jitterDelay,
  LARGE_TABLE_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  pauseAllOnStartup,
  type MonitorTask,
} from '../../src/monitor/monitorTypes';

function task(over: Partial<MonitorTask> = {}): MonitorTask {
  return {
    id: 'm1', kind: 'rowCount', connId: 'c1', database: 'app', table: 'orders',
    intervalMs: DEFAULT_INTERVAL_MS, condition: { type: 'anyChange' }, status: 'running',
    createdAt: 0, consecutiveFailures: 0, ...over,
  };
}

describe('monitor rules', () => {
  it('clamps the interval to 1 minute … 24 hours', () => {
    expect(clampInterval(1000)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(30_000)).toBe(30_000); // 秒级可用
    expect(clampInterval(3_000)).toBe(5_000); // 最短 5 秒
    expect(clampInterval(2 * 60_000 + 30_000)).toBe(150_000); // 自定义间隔
    expect(clampInterval(10 * 24 * 3_600_000)).toBe(MAX_INTERVAL_MS);
    expect(clampInterval(NaN)).toBe(DEFAULT_INTERVAL_MS);
    expect(clampInterval(5 * 60_000)).toBe(5 * 60_000);
  });

  it('uses a longer default interval for tables estimated above 1M rows', () => {
    expect(defaultIntervalFor(undefined)).toBe(DEFAULT_INTERVAL_MS);
    expect(defaultIntervalFor(1_000_000)).toBe(DEFAULT_INTERVAL_MS);
    expect(defaultIntervalFor(1_200_000)).toBe(LARGE_TABLE_INTERVAL_MS);
  });

  it('reads the estimated row count from the tree description only', () => {
    expect(estimatedRowsFromDescription('2589 rows')).toBe(2589);
    expect(estimatedRowsFromDescription('订单表')).toBeUndefined();
    expect(estimatedRowsFromDescription('-1 rows')).toBeUndefined();
    expect(estimatedRowsFromDescription(undefined)).toBeUndefined();
  });

  it('rejects unsupported engines, production, duplicates and limits', () => {
    const base = { dbType: 'MYSQL', production: false, connId: 'c1', database: 'app', table: 'orders', kind: 'rowCount' as const };
    const opts = { allowProduction: false, maxTasks: 20 };
    expect(checkCanCreate({ ...base, dbType: 'REDIS' }, [], opts)).toBe('unsupportedEngine');
    expect(checkCanCreate({ ...base, production: true }, [], opts)).toBe('production');
    expect(checkCanCreate({ ...base, production: true }, [], { ...opts, allowProduction: true })).toBeUndefined();
    expect(checkCanCreate(base, [task()], opts)).toBe('duplicate');
    const five = [1, 2, 3, 4, 5].map((i) => task({ id: `m${i}`, table: `t${i}` }));
    expect(checkCanCreate(base, five, opts)).toBe('connectionLimit');
    const others = [1, 2, 3].map((i) => task({ id: `x${i}`, connId: `c${i + 1}`, table: `t${i}` }));
    expect(checkCanCreate(base, others, { ...opts, maxTasks: 3 })).toBe('totalLimit');
    expect(checkCanCreate(base, others, opts)).toBeUndefined();
  });

  it('evaluates every condition and never fires a change condition without a baseline', () => {
    expect(evaluateCondition({ type: 'anyChange' }, undefined, 5)).toBe(false);
    expect(evaluateCondition({ type: 'anyChange' }, 5, 5)).toBe(false);
    expect(evaluateCondition({ type: 'anyChange' }, 5, 6)).toBe(true);
    expect(evaluateCondition({ type: 'increaseBy', value: 10 }, 100, 109)).toBe(false);
    expect(evaluateCondition({ type: 'increaseBy', value: 10 }, 100, 110)).toBe(true);
    expect(evaluateCondition({ type: 'decreaseBy', value: 10 }, 100, 90)).toBe(true);
    expect(evaluateCondition({ type: 'decreaseBy', value: 10 }, 100, 110)).toBe(false);
    expect(evaluateCondition({ type: 'changePercent', value: 10 }, 100, 89)).toBe(true);
    expect(evaluateCondition({ type: 'changePercent', value: 10 }, 100, 95)).toBe(false);
    expect(evaluateCondition({ type: 'changePercent', value: 10 }, 0, 1)).toBe(true);
    expect(evaluateCondition({ type: 'above', value: 50 }, undefined, 51)).toBe(true);
    expect(evaluateCondition({ type: 'below', value: 50 }, undefined, 50)).toBe(false);
  });

  it('respects the notification cooldown', () => {
    expect(canNotify(undefined, 0, 900_000)).toBe(true);
    expect(canNotify(0, 899_999, 900_000)).toBe(false);
    expect(canNotify(0, 900_000, 900_000)).toBe(true);
  });

  it('keeps jitter within 0–10% of the interval', () => {
    expect(jitterDelay(600_000, () => 0)).toBe(0);
    expect(jitterDelay(600_000, () => 1)).toBe(60_000);
    expect(jitterDelay(600_000, () => 5)).toBe(60_000);
  });

  it('records success, notifies once per cooldown and clears errors', () => {
    const first = applySuccess(task(), 10, 1000, 900_000);
    expect(first.notify).toBe(false);
    expect(first.task.lastValue).toBe(10);
    const changed = applySuccess({ ...first.task, lastError: 'x', status: 'error', consecutiveFailures: 2 }, 12, 2000, 900_000);
    expect(changed.notify).toBe(true);
    expect(changed.previous).toBe(10);
    expect(changed.task).toMatchObject({ status: 'running', consecutiveFailures: 0, lastNotifiedAt: 2000 });
    expect(changed.task.lastError).toBeUndefined();
    const again = applySuccess(changed.task, 14, 3000, 900_000);
    expect(again.notify).toBe(false);
    expect(again.task.lastNotifiedAt).toBe(2000);
  });

  it('pauses after repeated failures', () => {
    let t = task();
    for (let i = 1; i < FAILURES_BEFORE_PAUSE; i++) {
      const r = applyFailure(t, 'connect ECONNREFUSED', i);
      expect(r.paused).toBe(false);
      expect(r.task.status).toBe('error');
      t = r.task;
    }
    const last = applyFailure(t, 'x'.repeat(1000), 9);
    expect(last.paused).toBe(true);
    expect(last.task).toMatchObject({ status: 'paused', pausedReason: 'failures', consecutiveFailures: FAILURES_BEFORE_PAUSE });
    expect(last.task.lastError!.length).toBeLessThanOrEqual(300);
  });

  it('pauses every task on startup', () => {
    const tasks = pauseAllOnStartup([task(), task({ id: 'm2', status: 'error' }), task({ id: 'm3', status: 'paused', pausedReason: 'user' })]);
    expect(tasks.map((t) => [t.status, t.pausedReason])).toEqual([['paused', 'startup'], ['paused', 'startup'], ['paused', 'user']]);
  });

  it('fingerprints the target without the password', () => {
    const hash = (s: string) => s;
    const a = connectionFingerprint({ dbType: 'MYSQL', host: 'h', port: 3306, user: 'u' }, 'app', hash);
    expect(connectionFingerprint({ dbType: 'MYSQL', host: 'h', port: 3306, user: 'u' }, 'other', hash)).not.toBe(a);
    expect(connectionFingerprint({ dbType: 'MYSQL', host: 'h2', port: 3306, user: 'u' }, 'app', hash)).not.toBe(a);
    const url = connectionFingerprint({ dbType: 'PG', useConnectionString: true, connectionUrl: 'postgres://u:secret@h/db' }, 'db', hash);
    expect(url).not.toContain('secret');
  });
});
