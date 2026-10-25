import { describe, expect, it, vi } from 'vitest';
import { buildRowCountSql, MonitorExecutor, parseCountRow, type MonitorQuerySession } from '../../src/monitor/monitorExecutor';
import type { MonitorTask } from '../../src/monitor/monitorTypes';

const backtick = (s: string) => `\`${s}\``;
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

function task(over: Partial<MonitorTask> = {}): MonitorTask {
  return {
    id: 'm1', kind: 'rowCount', connId: 'c1', database: 'app', table: 'orders', intervalMs: 60_000,
    condition: { type: 'anyChange' }, status: 'running', createdAt: 0, consecutiveFailures: 0, ...over,
  };
}

function fakeSession(handler: (sql: string) => unknown, wrap = backtick) {
  const executed: Array<{ sql: string; opts: unknown }> = [];
  const close = vi.fn();
  const session: MonitorQuerySession = {
    query: {
      query: vi.fn(async (sql: string, _v?: unknown, opts?: unknown) => {
        executed.push({ sql, opts });
        return { rows: (await handler(sql)) as unknown[] };
      }),
      wrap,
    },
  };
  return { session, close, executed };
}

describe('buildRowCountSql', () => {
  it('quotes the table for each dialect and qualifies PG schemas', () => {
    expect(buildRowCountSql('MYSQL', backtick, 'oms_order')).toBe('SELECT COUNT(*) AS n FROM `oms_order`');
    expect(buildRowCountSql('SQLITE', quote, 'orders', 'ignored')).toBe('SELECT COUNT(*) AS n FROM "orders"');
    expect(buildRowCountSql('PG', quote, 'orders', 'sales')).toBe('SELECT COUNT(*) AS n FROM "sales"."orders"');
    expect(buildRowCountSql('PG', quote, '订单')).toBe('SELECT COUNT(*) AS n FROM "订单"');
  });

  it('rejects identifiers that could break out of quoting', () => {
    expect(() => buildRowCountSql('MYSQL', backtick, 'a`; DROP TABLE x; --')).toThrow(/Invalid SQL identifier/);
    expect(() => buildRowCountSql('MYSQL', backtick, 'a b')).toThrow();
  });
});

describe('parseCountRow', () => {
  it('accepts numbers, numeric strings and bigint', () => {
    expect(parseCountRow([{ n: 3 }])).toBe(3);
    expect(parseCountRow([{ n: '74' }])).toBe(74);
    expect(parseCountRow([{ n: 5n }])).toBe(5);
  });
  it('rejects empty and non-numeric results', () => {
    expect(() => parseCountRow([])).toThrow();
    expect(() => parseCountRow([{ n: 'abc' }])).toThrow();
    expect(() => parseCountRow([{ n: -1 }])).toThrow();
  });
});

describe('MonitorExecutor', () => {
  it('makes the session read-only once, then counts without query history', async () => {
    const fake = fakeSession((sql) => (sql.startsWith('SELECT') ? [{ n: '74' }] : []));
    const openSession = vi.fn(async () => ({ session: fake.session, close: fake.close }));
    const executor = new MonitorExecutor({ openSession, dbTypeOf: () => 'MYSQL', timeoutMs: () => 30_000 });
    expect(await executor.run(task({ table: 'lc_data_event' }))).toEqual({ value: 74 });
    expect(await executor.run(task({ id: 'm2', table: 'oms_order' }))).toEqual({ value: 74 });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(fake.executed.map((e) => e.sql)).toEqual([
      'SET SESSION TRANSACTION READ ONLY',
      'SELECT COUNT(*) AS n FROM `lc_data_event`',
      'SELECT COUNT(*) AS n FROM `oms_order`',
    ]);
    for (const e of fake.executed) expect(e.opts).toMatchObject({ skipHistory: true });
    executor.dispose();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('uses the PG and SQLite read-only statements', async () => {
    for (const [dbType, stmt] of [['PG', 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'], ['SQLITE', 'PRAGMA query_only = ON']] as const) {
      const fake = fakeSession((sql) => (sql.startsWith('SELECT') ? [{ n: 1 }] : []), quote);
      const executor = new MonitorExecutor({ openSession: async () => ({ session: fake.session, close: fake.close }), dbTypeOf: () => dbType, timeoutMs: () => 30_000 });
      await executor.run(task());
      expect(fake.executed[0]!.sql).toBe(stmt);
      executor.dispose();
    }
  });

  it('runs tasks on the same connection one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const fake = fakeSession(async (sql) => {
      if (!sql.startsWith('SELECT')) return [];
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return [{ n: 1 }];
    });
    const executor = new MonitorExecutor({ openSession: async () => ({ session: fake.session, close: fake.close }), dbTypeOf: () => 'MYSQL', timeoutMs: () => 30_000 });
    await Promise.all([executor.run(task()), executor.run(task({ id: 'm2', table: 'b' })), executor.run(task({ id: 'm3', table: 'c' }))]);
    expect(maxActive).toBe(1);
    executor.dispose();
  });

  it('times out, cancels the query and drops the session', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const close = vi.fn();
      const session: MonitorQuerySession = {
        query: {
          wrap: backtick,
          query: vi.fn((sql: string, _v?: unknown, opts?: { token?: { cancel?: () => void } }) => {
            if (!sql.startsWith('SELECT')) return Promise.resolve({ rows: [] as unknown[] });
            if (opts?.token) opts.token.cancel = cancel;
            return new Promise<{ rows?: unknown[] }>(() => undefined);
          }),
        },
      };
      const openSession = vi.fn(async () => ({ session, close }));
      const executor = new MonitorExecutor({ openSession, dbTypeOf: () => 'MYSQL', timeoutMs: () => 5_000 });
      const run = executor.run(task());
      const assertion = expect(run).rejects.toThrow(/timed out after 5s/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      executor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes an idle session after the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSession((sql) => (sql.startsWith('SELECT') ? [{ n: 1 }] : []));
      const executor = new MonitorExecutor({
        openSession: async () => ({ session: fake.session, close: fake.close }),
        dbTypeOf: () => 'MYSQL', timeoutMs: () => 30_000, idleCloseMs: 60_000,
      });
      await executor.run(task());
      expect(fake.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fake.close).toHaveBeenCalledTimes(1);
      executor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast for a missing connection and closes the session if read-only cannot be set', async () => {
    const executor = new MonitorExecutor({ openSession: vi.fn(), dbTypeOf: () => undefined, timeoutMs: () => 1000 });
    await expect(executor.run(task())).rejects.toThrow(/connection not found/);

    const fake = fakeSession((sql) => { if (sql.startsWith('SET')) throw new Error('denied'); return []; });
    const strict = new MonitorExecutor({ openSession: async () => ({ session: fake.session, close: fake.close }), dbTypeOf: () => 'MYSQL', timeoutMs: () => 1000 });
    await expect(strict.run(task())).rejects.toThrow(/denied/);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.executed.some((e) => e.sql.startsWith('SELECT'))).toBe(false);
  });
});

import { advanceCursor, buildNewRowsSql, executeTask, readCursorBaseline } from '../../src/monitor/monitorExecutor';

describe('new rows (B)', () => {
  const base = { table: 'events', cursorColumn: 'id', primaryKey: ['id'] as string[] };

  it('builds a parameterised >= query per dialect and inlines only validated integers for SQLite', () => {
    expect(buildNewRowsSql('MYSQL', backtick, { ...base, cursorValue: '10', cursorSeen: ['["10"]'] }))
      .toEqual({ sql: 'SELECT * FROM `events` WHERE `id` >= ? ORDER BY `id`, `id` LIMIT 52', params: ['10'], limit: 52 });
    expect(buildNewRowsSql('PG', quote, { ...base, schema: 's', cursorValue: '10' }).sql)
      .toBe('SELECT * FROM "s"."events" WHERE "id" >= $1 ORDER BY "id", "id" LIMIT 51');
    expect(buildNewRowsSql('SQLITE', quote, { ...base, cursorValue: '10' }))
      .toEqual({ sql: 'SELECT * FROM "events" WHERE "id" >= 10 ORDER BY "id", "id" LIMIT 51', limit: 51 });
    expect(() => buildNewRowsSql('SQLITE', quote, { ...base, cursorValue: "1; DROP TABLE x" })).toThrow(/invalid cursor value/);
    expect(buildNewRowsSql('MYSQL', backtick, { table: 'events', cursorColumn: 'ts', primaryKey: [], cursorValue: '2026-10-25 10:00:00' }).sql)
      .toBe('SELECT * FROM `events` WHERE `ts` > ? ORDER BY `ts` LIMIT 51');
  });

  it('skips rows already seen at the cursor value and advances the cursor', () => {
    const rows = [{ id: 10, ts: 'a' }, { id: 11 }, { id: 12 }];
    const r = advanceCursor({ ...base, cursorValue: '10', cursorSeen: [JSON.stringify(['10'])] }, rows);
    expect(r.added.map((x) => x.id)).toEqual([11, 12]);
    expect(r.cursor).toEqual({ value: '12', seen: [JSON.stringify(['12'])] });
  });

  it('keeps several rows that share the same cursor value', () => {
    const t = { table: 'e', cursorColumn: 'ts', primaryKey: ['id'], cursorValue: '5', cursorSeen: [JSON.stringify(['1'])] };
    const r = advanceCursor(t, [{ id: 1, ts: 5 }, { id: 2, ts: 5 }, { id: 3, ts: 5 }]);
    expect(r.added.map((x) => x.id)).toEqual([2, 3]);
    expect(r.cursor!.value).toBe('5');
    expect(new Set(r.cursor!.seen)).toEqual(new Set([JSON.stringify(['1']), JSON.stringify(['2']), JSON.stringify(['3'])]));
  });

  it('reports "more" beyond 50 rows and jumps the cursor to the current maximum', async () => {
    const fresh = Array.from({ length: 51 }, (_, i) => ({ id: 101 + i }));
    const fake = fakeSession((sql) => {
      if (sql.startsWith('SELECT * FROM')) return fresh;
      if (sql.startsWith('SELECT COUNT(*)')) return [{ n: 120 }];
      if (sql.startsWith('SELECT MAX')) return [{ v: 220 }];
      if (sql.startsWith('SELECT `id`')) return [{ id: 220 }];
      return [];
    });
    const out = await executeTask(fake.session, 'MYSQL', task({ kind: 'newRows', table: 'events', cursorColumn: 'id', primaryKey: ['id'], cursorValue: '100', cursorSeen: [JSON.stringify(['100'])] }), {});
    expect(out.value).toBe(119);
    expect(out.rows).toHaveLength(50);
    expect(out.more).toBe(true);
    expect(out.cursor).toEqual({ value: '220', seen: [JSON.stringify(['220'])] });
  });

  it('reads the baseline as MAX(cursor) and the primary keys on it', async () => {
    const fake = fakeSession((sql) => (sql.startsWith('SELECT MAX') ? [{ v: '1792857182179' }] : [{ id: 7, received_time: '1792857182179' }]));
    const baseline = await readCursorBaseline(fake.session, 'MYSQL', { table: 'lc_data_event', cursorColumn: 'received_time', primaryKey: ['id'] }, {});
    expect(baseline).toEqual({ value: '1792857182179', seen: [JSON.stringify(['7'])] });
    expect(fake.executed[1]!.sql).toBe('SELECT `id`, `received_time` FROM `lc_data_event` WHERE `received_time` >= ? ORDER BY `id` LIMIT 1000');
  });

  it('returns no baseline for an empty table', async () => {
    const fake = fakeSession(() => [{ v: null }]);
    expect(await readCursorBaseline(fake.session, 'MYSQL', { table: 't', cursorColumn: 'id', primaryKey: ['id'] }, {})).toBeUndefined();
  });
});

describe('metric (A2)', () => {
  it('re-checks the SQL before every run and returns the watched column', async () => {
    const fake = fakeSession(() => [{ lag_seconds: '34165', rows_last_1h: '0' }]);
    const out = await executeTask(fake.session, 'MYSQL', task({ kind: 'metric', sql: 'SELECT 1 AS lag_seconds, 0 AS rows_last_1h', watchColumn: 'lag_seconds' }), {});
    expect(out).toEqual({ value: 34165, values: { lag_seconds: 34165, rows_last_1h: 0 } });
    await expect(executeTask(fake.session, 'MYSQL', task({ kind: 'metric', sql: 'DELETE FROM t', watchColumn: 'x' }), {})).rejects.toThrow(/rejected/);
    expect(fake.executed).toHaveLength(1);
  });

  it('fails when the result shape changes', async () => {
    const fake = fakeSession(() => [{ a: 1 }, { a: 2 }]);
    await expect(executeTask(fake.session, 'MYSQL', task({ kind: 'metric', sql: 'SELECT a FROM t', watchColumn: 'a' }), {})).rejects.toThrow(/tooManyRows/);
  });

  it('sets the PG search_path to the task schema on a fresh session', async () => {
    const fake = fakeSession((sql) => (sql.startsWith('SELECT') ? [{ n: 1 }] : []), quote);
    const executor = new MonitorExecutor({ openSession: async () => ({ session: fake.session, close: fake.close }), dbTypeOf: () => 'PG', timeoutMs: () => 30_000 });
    await executor.run(task({ schema: 'sales' }));
    expect(fake.executed.map((e) => e.sql).slice(0, 2)).toEqual(['SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', 'SET search_path TO "sales", public']);
    executor.dispose();
  });
});
