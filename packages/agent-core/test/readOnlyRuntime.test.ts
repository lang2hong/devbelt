import { describe, expect, it } from 'vitest';
import { explainReadOnly, runReadOnlyQuery } from '../src/index.js';
import type { ReadOnlyQuerySession } from '../src/index.js';
import type { QueryOptions, QueryResult } from '@devbelt/db-core';

type Handler = (sql: string) => Partial<QueryResult> | Error;

function fakeSession(handler: Handler = () => ({ rows: [], fields: [] })) {
  const calls: Array<{ sql: string; options?: QueryOptions }> = [];
  const session: ReadOnlyQuerySession = {
    async query(sql: string, _values?: unknown, options?: QueryOptions) {
      calls.push({ sql, ...(options ? { options } : {}) });
      const out = handler(sql);
      if (out instanceof Error) throw out;
      return { sql, costTime: 0, rows: [], fields: [], ...out } as QueryResult;
    },
  };
  return { session, calls, sqls: () => calls.map((c) => c.sql) };
}

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe('runReadOnlyQuery', () => {
  it('wraps PG reads in BEGIN READ ONLY / SET LOCAL timeout / ROLLBACK', async () => {
    const f = fakeSession((sql) => (sql.startsWith('SELECT * FROM (') ? { rows: rowsOf(2), fields: [{ name: 'id' } as never] } : {}));
    const r = await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT id FROM t', { timeoutMs: 5000, maxRows: 10 });
    expect(r.ok).toBe(true);
    expect(f.sqls()).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 5000',
      'SELECT * FROM (SELECT id FROM t) AS devbelt_q LIMIT 11',
      'ROLLBACK',
    ]);
    // Control statements and the user statement never enter query history.
    expect(f.calls.every((c) => c.options?.skipHistory === true)).toBe(true);
  });

  it('wraps MySQL reads in START TRANSACTION READ ONLY / ROLLBACK with max_execution_time', async () => {
    const f = fakeSession();
    await runReadOnlyQuery({ engine: 'MYSQL', session: f.session, sessionReadOnly: false }, 'SELECT 1', { timeoutMs: 2000 });
    expect(f.sqls()).toEqual([
      'SET SESSION max_execution_time = 2000',
      'START TRANSACTION READ ONLY',
      'SELECT * FROM (SELECT 1) AS devbelt_q LIMIT 1001',
      'ROLLBACK',
    ]);
  });

  it('requires a read-only session on SQLite and runs without transaction control', async () => {
    const f = fakeSession();
    expect(await runReadOnlyQuery({ engine: 'SQLITE', session: f.session, sessionReadOnly: false }, 'SELECT 1'))
      .toEqual({ ok: false, reason: 'session_not_read_only' });
    expect(f.calls).toHaveLength(0);
    await runReadOnlyQuery({ engine: 'SQLITE', session: f.session, sessionReadOnly: true }, 'SELECT 1');
    expect(f.sqls()).toEqual(['SELECT * FROM (SELECT 1) AS devbelt_q LIMIT 1001']);
  });

  it('rejects unsafe SQL before touching the database', async () => {
    const f = fakeSession();
    const r = await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, "SELECT nextval('s')");
    expect(r).toEqual({ ok: false, reason: 'forbidden_function', detail: 'nextval' });
    expect(f.calls).toHaveLength(0);
  });

  it('rolls back and returns a sanitised error when the statement fails', async () => {
    const f = fakeSession((sql) => (sql.startsWith('SELECT * FROM (') ? new Error("relation \"t\" does not exist; mysql://root:secret@db") : {}));
    const r = await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT * FROM t');
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== 'query_failed') throw new Error('expected query_failed');
    expect(r.envelope.untrusted).toBe(true);
    expect(r.envelope.data.error).toContain('root:***@');
    expect(r.envelope.data.error).not.toContain('secret');
    expect(f.sqls().at(-1)).toBe('ROLLBACK');
  });

  it('keeps the original error when ROLLBACK itself fails', async () => {
    const f = fakeSession((sql) => {
      if (sql === 'ROLLBACK') return new Error('connection lost');
      if (sql.startsWith('SELECT * FROM (')) return new Error('boom');
      return {};
    });
    const r = await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT 1');
    if (r.ok || r.reason !== 'query_failed') throw new Error('expected query_failed');
    expect(r.envelope.data.error).toBe('boom');
  });

  it('does not run the statement if the read-only transaction cannot start', async () => {
    const f = fakeSession((sql) => (sql === 'BEGIN READ ONLY' ? new Error('nope') : {}));
    const r = await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT 1');
    expect(r.ok).toBe(false);
    expect(f.sqls()).toEqual(['BEGIN READ ONLY']);
  });

  it('caps rows, marks truncation and sanitises by default', async () => {
    const f = fakeSession((sql) => (sql.startsWith('SELECT * FROM (')
      ? { rows: Array.from({ length: 6 }, (_, i) => ({ id: i, password: `p${i}` })), fields: [{ name: 'id' }, { name: 'password' }] as never }
      : {}));
    const r = await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT id, password FROM u', { maxRows: 5 });
    if (!r.ok) throw new Error('expected ok');
    expect(r.truncated).toBe(true);
    expect(r.envelope.truncated).toBe(true);
    expect(r.envelope.data.rowCount).toBe(5);
    expect(r.envelope.notes).toContain('result limited to 5 rows');
    expect(r.envelope.data.sample).toBeUndefined();
    expect(JSON.stringify(r.envelope)).not.toContain('p1');
    expect(r.envelope.data.columns.find((c) => c.name === 'password')).toMatchObject({ sensitive: true });
  });

  it('passes the cancel token only to the user statement', async () => {
    const f = fakeSession();
    const token = {};
    await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT 1', { token });
    const withToken = f.calls.filter((c) => c.options?.token === token).map((c) => c.sql);
    expect(withToken).toEqual(['SELECT * FROM (SELECT 1) AS devbelt_q LIMIT 1001']);
  });

  it('clamps maxRows and timeout to safe bounds', async () => {
    const f = fakeSession();
    await runReadOnlyQuery({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT 1', { maxRows: 1e9, timeoutMs: -5 });
    expect(f.sqls()).toContain('SET LOCAL statement_timeout = 1');
    expect(f.sqls()).toContain('SELECT * FROM (SELECT 1) AS devbelt_q LIMIT 10001');
  });
});

describe('explainReadOnly', () => {
  it('runs plain EXPLAIN without the LIMIT wrapper inside a read-only transaction', async () => {
    const f = fakeSession((sql) => (sql.startsWith('EXPLAIN') ? { rows: [{ plan: 'Seq Scan' }] } : {}));
    const r = await explainReadOnly({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'EXPLAIN SELECT * FROM t');
    expect(r).toEqual({ ok: true, rows: [{ plan: 'Seq Scan' }] });
    expect(f.sqls()).toEqual(['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 30000', 'EXPLAIN SELECT * FROM t', 'ROLLBACK']);
  });

  it('refuses EXPLAIN ANALYZE and non-EXPLAIN statements', async () => {
    const f = fakeSession();
    expect(await explainReadOnly({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'EXPLAIN ANALYZE SELECT 1'))
      .toMatchObject({ ok: false, reason: 'explain_analyze' });
    expect(await explainReadOnly({ engine: 'PG', session: f.session, sessionReadOnly: false }, 'SELECT 1'))
      .toEqual({ ok: false, reason: 'not_explain' });
    expect(f.calls).toHaveLength(0);
  });
});
