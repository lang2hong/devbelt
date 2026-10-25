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
    expect(await executor.run(task({ table: 'lc_data_event' }))).toBe(74);
    expect(await executor.run(task({ id: 'm2', table: 'oms_order' }))).toBe(74);
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
