import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { dryRunStatement, targetTable } from '../../src/agent/dryRun.js';

function fakeSession(opts: { affectedRows?: number; triggerCount?: number; failOn?: string; throwTriggerLookup?: boolean } = {}) {
  const sql: string[] = [];
  const values: unknown[] = [];
  return {
    sql,
    values,
    async query(statement: string, vals?: unknown) {
      sql.push(statement);
      if (vals !== undefined) values.push(vals);
      if (opts.throwTriggerLookup && statement.includes('information_schema.triggers')) throw new Error('no access');
      if (statement.includes('information_schema.triggers')) {
        return { rows: [{ n: opts.triggerCount ?? 0 }] } as never;
      }
      if (opts.failOn && statement.includes(opts.failOn)) throw new Error('syntax error');
      return { affectedRows: opts.affectedRows ?? 0 } as never;
    },
  };
}

const deps = (dbType: DatabaseType, session: ReturnType<typeof fakeSession>) => ({ dbType, session, schema: 'public' });

describe('dryRunStatement', () => {
  it('runs DML in a transaction and rolls it back', async () => {
    const s = fakeSession({ affectedRows: 12 });
    const r = await dryRunStatement('UPDATE orders SET status = 1 WHERE id > 0', deps(DatabaseType.PG, s));
    expect(r).toEqual({ outcome: 'rolled_back', affectedRows: 12 });
    expect(s.sql.slice(-3)).toEqual(['BEGIN', 'UPDATE orders SET status = 1 WHERE id > 0', 'ROLLBACK']);
    expect(s.sql[0]).toContain('information_schema.triggers');
  });

  it('rolls back and reports the error when the statement fails', async () => {
    const s = fakeSession({ failOn: 'UPDATE' });
    const r = await dryRunStatement('UPDATE orders SET x = 1', deps(DatabaseType.MYSQL, s));
    expect(r).toEqual({ outcome: 'failed', reason: 'syntax error' });
    expect(s.sql.slice(-3)).toEqual(['START TRANSACTION', 'UPDATE orders SET x = 1', 'ROLLBACK']);
  });

  it('skips the dry run when the table has triggers', async () => {
    const s = fakeSession({ triggerCount: 1 });
    const r = await dryRunStatement('DELETE FROM orders WHERE id = 1', deps(DatabaseType.PG, s));
    expect(r).toEqual({ outcome: 'static_only', reason: 'triggers' });
    expect(s.sql).toHaveLength(1);
    expect(s.sql[0]).toContain('information_schema.triggers');
  });

  it('skips the dry run when triggers cannot be checked', async () => {
    const s = fakeSession({ throwTriggerLookup: true });
    expect(await dryRunStatement('DELETE FROM orders', deps(DatabaseType.PG, s))).toEqual({ outcome: 'static_only', reason: 'triggers' });
  });

  it('never executes DDL, SQLite DML or unknown tables', async () => {
    const ddl = fakeSession();
    expect(await dryRunStatement('ALTER TABLE t ADD COLUMN x int', deps(DatabaseType.PG, ddl))).toEqual({ outcome: 'static_only', reason: 'not_dml' });
    expect(ddl.sql).toEqual([]);

    const sqlite = fakeSession();
    expect(await dryRunStatement('UPDATE t SET a = 1', deps(DatabaseType.SQLITE, sqlite))).toEqual({ outcome: 'static_only', reason: 'sqlite_transaction' });
    expect(sqlite.sql).toEqual([]);

    const join = fakeSession();
    expect((await dryRunStatement('UPDATE a JOIN b ON a.id = b.id SET a.x = 1', deps(DatabaseType.PG, join))).outcome).toBe('static_only');
    expect(join.sql).toEqual([]);
  });
});

describe('targetTable', () => {
  it('extracts single-table DML targets', () => {
    expect(targetTable('UPDATE `orders` SET a = 1')).toBe('orders');
    expect(targetTable('DELETE FROM "sales"."orders" WHERE id = 1')).toBe('orders');
    expect(targetTable('INSERT INTO [users] (a) VALUES (1)')).toBe('users');
  });

  it('returns undefined for multi-table or unrecognised statements', () => {
    expect(targetTable('UPDATE a JOIN b ON a.id = b.id SET a.x = 1')).toBeUndefined();
    expect(targetTable('SELECT 1')).toBeUndefined();
  });
});