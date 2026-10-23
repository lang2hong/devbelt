import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { extractPredicates, parsePostgresExplain, suggestIndexes } from '@devbelt/explain-core';
import type { AdvisorTable, ExplainPlan, ExplainPlanNode } from '@devbelt/explain-core';

/**
 * P10: real PostgreSQL `EXPLAIN (FORMAT JSON)` → explain-core parser / index advisor.
 *
 * Plain EXPLAIN only (never ANALYZE): the statements are planned, not run.
 * Everything lives in a temporary `ztest_p10_*` schema dropped in afterAll.
 * Gate: DEVBELT_DB_TEST_PG_URL.
 */
const URL = process.env.DEVBELT_DB_TEST_PG_URL;
const SCHEMA = `ztest_p10_${Date.now()}`;

const ORDERS_TABLE: AdvisorTable = {
  name: 'orders',
  columns: [
    { name: 'id', type: 'integer', isPrimary: true },
    { name: 'user_id', type: 'integer' },
    { name: 'status', type: 'varchar(20)' },
    { name: 'amount', type: 'integer' },
    { name: 'created_at', type: 'timestamp' },
  ],
  indexes: [
    { name: 'orders_pkey', columns: ['id'], isPrimary: true, isUnique: true },
    { name: 'idx_user', columns: ['user_id'] },
  ],
};

describe.skipIf(!URL)('P10 EXPLAIN on real PostgreSQL', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL! });
    await client.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    // Deterministic plans: no parallel workers splitting row estimates.
    await client.query('SET max_parallel_workers_per_gather = 0');
    await client.query(`CREATE TABLE users (
      id serial PRIMARY KEY,
      email varchar(120) NOT NULL UNIQUE,
      active boolean NOT NULL DEFAULT true
    )`);
    await client.query(`CREATE TABLE orders (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      status varchar(20) NOT NULL,
      amount integer NOT NULL,
      created_at timestamp NOT NULL
    )`);
    await client.query('CREATE INDEX idx_user ON orders (user_id)');
    await client.query(`INSERT INTO users (email, active)
      SELECT 'u' || g || '@x.test', g % 2 = 0 FROM generate_series(1, 200) g`);
    await client.query(`INSERT INTO orders (user_id, status, amount, created_at)
      SELECT (g % 200) + 1,
             (ARRAY['new', 'paid', 'shipped', 'cancelled'])[(g % 4) + 1],
             g % 997,
             timestamp '2026-01-01' + (g % 300) * interval '1 day'
      FROM generate_series(1, 20000) g`);
    await client.query('ANALYZE users');
    await client.query('ANALYZE orders');
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await client.end();
    }
  });

  async function plan(sql: string, on: Client = client): Promise<ExplainPlan> {
    const res = await on.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    const parsed = parsePostgresExplain(res.rows);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.plan;
  }

  function flat(nodes: readonly ExplainPlanNode[]): ExplainPlanNode[] {
    return nodes.flatMap((n) => [n, ...flat(n.children)]);
  }

  it('parses a large seq scan with a filter and suggests the filter column', async () => {
    const sql = "SELECT * FROM orders WHERE status = 'paid'";
    const p = await plan(sql);
    const scan = flat(p.roots).find((n) => n.object === 'orders');
    expect(scan?.operation).toBe('Seq Scan');
    expect(scan?.estimatedRows).toBeGreaterThanOrEqual(1000);
    expect(scan?.warnings).toEqual(expect.arrayContaining(['fullTableScan', 'missingIndex']));
    expect(scan?.filter).toContain('paid');

    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [ORDERS_TABLE] });
    expect(advice.suggestions.map((s) => [s.table, s.columns])).toEqual([['orders', ['status']]]);
  });

  it('uses the existing index for an indexed equality filter', async () => {
    const p = await plan('SELECT * FROM orders WHERE user_id = 7');
    // The planner may pick Index Scan or Bitmap Heap/Index Scan: only assert that idx_user is used.
    expect(flat(p.roots).some((n) => n.index === 'idx_user')).toBe(true);
    expect(p.warnings).not.toContain('fullTableScan');
  });

  it('maps aliases: PostgreSQL reports the real relation name', async () => {
    const sql = "SELECT o.id FROM orders o WHERE o.status = 'paid'";
    const p = await plan(sql);
    expect(flat(p.roots).find((n) => n.operation === 'Seq Scan')?.object).toBe('orders');
    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [ORDERS_TABLE] });
    expect(advice.suggestions.map((s) => [s.table, s.columns])).toEqual([['orders', ['status']]]);
  });

  it('parses joins and keeps both tables in the tree', async () => {
    const p = await plan('SELECT u.email, o.amount FROM users u JOIN orders o ON o.user_id = u.id WHERE u.active');
    const tables = flat(p.roots).map((n) => n.object).filter(Boolean);
    expect([...new Set(tables)].sort()).toEqual(['orders', 'users']);
    expect(flat(p.roots).every((n) => typeof n.id === 'string' && n.id.length > 0)).toBe(true);
  });

  it('shows a Sort node for ORDER BY on a non-indexed column (no filesort warning without ANALYZE)', async () => {
    const p = await plan("SELECT id FROM orders WHERE status = 'new' ORDER BY amount DESC");
    expect(flat(p.roots).some((n) => n.operation === 'Sort')).toBe(true);
    expect(p.warnings).not.toContain('filesort');
  });

  it('resolves unqualified tables only through search_path (panel schema node behaviour)', async () => {
    const other = new Client({ connectionString: URL! });
    await other.connect();
    try {
      await expect(other.query('EXPLAIN (FORMAT JSON) SELECT * FROM orders')).rejects.toMatchObject({ code: '42P01' });
      await other.query(`SET search_path TO "${SCHEMA}", public`);
      const p = await plan('SELECT * FROM orders', other);
      expect(flat(p.roots).find((n) => n.operation === 'Seq Scan')?.object).toBe('orders');
    } finally {
      await other.end();
    }
  });
});
