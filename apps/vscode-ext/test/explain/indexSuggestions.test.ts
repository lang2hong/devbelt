import { describe, expect, it, vi } from 'vitest';
import { DatabaseType, MysqlDialect, PostgreSqlDialect } from '@devbelt/db-core';
import type { ExplainPlan, ExplainPlanNode } from '@devbelt/explain-core';
import { buildIndexSuggestions, flaggedTables, MAX_ADVISED_TABLES } from '../../src/explain/indexSuggestions';

function scan(table: string, warnings: ExplainPlanNode['warnings'] = ['fullTableScan']): ExplainPlanNode {
  return { id: table, operation: 'Seq Scan', object: table, estimatedRows: 50000, warnings, children: [] };
}

function plan(...roots: ExplainPlanNode[]): ExplainPlan {
  return { dialect: 'mysql', roots, warnings: ['fullTableScan'], raw: null };
}

function col(name: string, extra: Record<string, unknown> = {}) {
  return { name, type: 'int', isPrimary: false, isUnique: false, ...extra };
}

function metadata(dialect: { createIndexSql: (...a: any[]) => string }, tables: Record<string, { columns: any[]; indexes?: any[] }>) {
  return {
    getColumns: vi.fn(async (t: string) => {
      if (!tables[t]) throw new Error(`no table ${t}`);
      return tables[t].columns;
    }),
    getIndexes: vi.fn(async (t: string) => tables[t]?.indexes ?? []),
    createIndexSql: (...args: any[]) => dialect.createIndexSql(...args),
  };
}

describe('flaggedTables', () => {
  it('maps alias node names back to real tables', () => {
    expect(flaggedTables(plan(scan('o'), scan('u', [])), { o: 'orders', u: 'users' })).toEqual(['orders']);
  });

  it('lists tables with full scans or filesort once, in plan order', () => {
    const p = plan(
      { id: 'j', operation: 'Nested Loop', warnings: [], children: [scan('orders'), scan('users', []), scan('orders')] },
      scan('logs', ['filesort']),
    );
    expect(flaggedTables(p)).toEqual(['orders', 'logs']);
  });
});

describe('buildIndexSuggestions', () => {
  it('builds MySQL DDL with the declared column names and the target database', async () => {
    const md = metadata(new MysqlDialect(), {
      orders: { columns: [col('id', { isPrimary: true }), col('Status', { type: 'varchar(20)' })] },
    });
    const r = await buildIndexSuggestions("SELECT * FROM orders WHERE Status = 'paid'", plan(scan('orders')), {
      session: { metadata: md as any },
      dbType: DatabaseType.MYSQL,
      database: 'app',
    });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ table: 'orders', columns: ['Status'], name: 'idx_orders_status', confidence: 'medium' });
    expect(r.suggestions[0].sql).toBe('CREATE INDEX `idx_orders_status` ON `app`.`orders` (`Status`)');
    expect(md.getColumns).toHaveBeenCalledWith('orders', 'app', undefined);
  });

  it('builds PostgreSQL DDL qualified with the schema', async () => {
    const md = metadata(new PostgreSqlDialect(), {
      orders: { columns: [col('id', { isPrimary: true }), col('customer_id'), col('created_at')] },
    });
    const r = await buildIndexSuggestions(
      "SELECT * FROM orders WHERE customer_id = 1 AND created_at > '2026-01-01'",
      plan(scan('orders')),
      { session: { metadata: md as any }, dbType: DatabaseType.PG, schema: 'sales' },
    );
    expect(r.suggestions[0].sql).toBe('CREATE INDEX "idx_orders_customer_id_created_at" ON "sales"."orders" ("customer_id", "created_at")');
  });

  it('only reads metadata for flagged tables that appear in the SQL', async () => {
    const md = metadata(new MysqlDialect(), {
      orders: { columns: [col('user_id')] },
      users: { columns: [col('id', { isPrimary: true })] },
    });
    await buildIndexSuggestions(
      'SELECT * FROM orders o JOIN users u ON u.id = o.user_id',
      plan(scan('orders'), scan('users', [])),
      { session: { metadata: md as any }, dbType: DatabaseType.MYSQL },
    );
    expect(md.getColumns.mock.calls.map((c) => c[0])).toEqual(['orders']);
  });

  it('skips a table whose metadata cannot be read', async () => {
    const md = metadata(new MysqlDialect(), { orders: { columns: [col('status')] } });
    const r = await buildIndexSuggestions(
      'SELECT * FROM orders o JOIN missing m ON m.id = o.mid WHERE o.status = 1',
      plan(scan('orders'), scan('missing')),
      { session: { metadata: md as any }, dbType: DatabaseType.MYSQL },
    );
    expect(r.suggestions.map((s) => s.table)).toEqual(['orders']);
  });

  it(`caps metadata reads at ${MAX_ADVISED_TABLES} tables`, async () => {
    const names = Array.from({ length: 8 }, (_, i) => `t${i}`);
    const md = metadata(new MysqlDialect(), Object.fromEntries(names.map((n) => [n, { columns: [col('a')] }])));
    await buildIndexSuggestions(
      `SELECT * FROM ${names.join(', ')}`,
      plan(...names.map((n) => scan(n))),
      { session: { metadata: md as any }, dbType: DatabaseType.MYSQL },
    );
    expect(md.getColumns).toHaveBeenCalledTimes(MAX_ADVISED_TABLES);
  });

  it('drops a suggestion whose identifiers fail validation instead of emitting unsafe DDL', async () => {
    const md = metadata(new MysqlDialect(), { orders: { columns: [col('status')] } });
    md.createIndexSql = () => { throw new Error('Invalid SQL identifier'); };
    const r = await buildIndexSuggestions("SELECT * FROM orders WHERE status = 'x'", plan(scan('orders')), {
      session: { metadata: md as any },
      dbType: DatabaseType.MYSQL,
    });
    expect(r.suggestions).toEqual([]);
  });

  it('returns nothing without flagged tables and does not touch metadata', async () => {
    const md = metadata(new MysqlDialect(), {});
    const r = await buildIndexSuggestions('SELECT * FROM orders WHERE a = 1', plan(scan('orders', [])), {
      session: { metadata: md as any },
      dbType: DatabaseType.MYSQL,
    });
    expect(r).toEqual({ suggestions: [], redundant: [] });
    expect(md.getColumns).not.toHaveBeenCalled();
  });

  it('reports redundant prefix indexes on flagged tables', async () => {
    const md = metadata(new MysqlDialect(), {
      orders: {
        columns: [col('a'), col('b')],
        indexes: [{ name: 'idx_a', columns: ['a'] }, { name: 'idx_a_b', columns: ['a', 'b'] }],
      },
    });
    const r = await buildIndexSuggestions('SELECT * FROM orders WHERE a = 1', plan(scan('orders')), {
      session: { metadata: md as any },
      dbType: DatabaseType.MYSQL,
    });
    expect(r.suggestions).toEqual([]);
    expect(r.redundant).toEqual([{ table: 'orders', index: 'idx_a', coveredBy: 'idx_a_b' }]);
  });

  it('suggests indexes when the SQL and the plan use table aliases', async () => {
    const md = metadata(new MysqlDialect(), {
      orders: { columns: [col('id', { isPrimary: true }), col('user_id'), col('status')] },
      users: { columns: [col('id', { isPrimary: true })] },
    });
    const r = await buildIndexSuggestions(
      "SELECT o.id FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'paid'",
      plan({ id: 'j', operation: 'Nested loop join', warnings: [], children: [scan('o'), scan('u', [])] }),
      { session: { metadata: md as any }, dbType: DatabaseType.MYSQL, database: 'app' },
    );
    expect(md.getColumns.mock.calls.map((c) => c[0])).toEqual(['orders']);
    expect(r.suggestions).toEqual([
      expect.objectContaining({ table: 'orders', columns: ['user_id', 'status'] }),
    ]);
    expect(r.suggestions[0].sql).toBe('CREATE INDEX `idx_orders_user_id_status` ON `app`.`orders` (`user_id`, `status`)');
  });
});
