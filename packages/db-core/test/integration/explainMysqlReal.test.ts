import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, type Connection } from 'mysql2/promise';
import { extractPredicates, parseMysqlExplain, suggestIndexes } from '@devbelt/explain-core';
import type { AdvisorTable, ExplainPlan, ExplainPlanNode } from '@devbelt/explain-core';
import { resolveTestDb, parseMysqlUrl } from './testDb.js';

/**
 * P10 S9: real MySQL `EXPLAIN FORMAT=JSON` → explain-core parser / index advisor.
 *
 * Plain EXPLAIN only (never ANALYZE): the statements are planned, not run.
 * Temporary `z_p10_*` tables live in the verification database and are dropped
 * in afterAll. Gate: DEVBELT_DB_TEST_MYSQL_URL (+ resolveTestDb guard).
 */
const URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;
const DB = URL ? resolveTestDb() : 'skipped';
const STAMP = Date.now();
const USERS = `z_p10_users_${STAMP}`;
const ORDERS = `z_p10_orders_${STAMP}`;

describe.skipIf(!URL)('P10 EXPLAIN on real MySQL', () => {
  let con: Connection;

  beforeAll(async () => {
    con = await createConnection({ ...parseMysqlUrl(URL!), database: DB, connectTimeout: 10_000 });
    await con.query(`CREATE TABLE \`${USERS}\` (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(120) NOT NULL UNIQUE,
      active TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB`);
    await con.query(`CREATE TABLE \`${ORDERS}\` (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      status VARCHAR(20) NOT NULL,
      amount INT NOT NULL,
      created_at DATETIME NOT NULL,
      note VARCHAR(50) NULL,
      KEY idx_user (user_id)
    ) ENGINE=InnoDB`);
    const users = Array.from({ length: 200 }, (_, i) => `('u${i}@x.test', ${i % 2})`).join(',');
    await con.query(`INSERT INTO \`${USERS}\` (email, active) VALUES ${users}`);
    const statuses = ['new', 'paid', 'shipped', 'cancelled'];
    for (let chunk = 0; chunk < 4; chunk++) {
      const rows = Array.from({ length: 1000 }, (_, j) => {
        const i = chunk * 1000 + j;
        return `(${(i % 200) + 1}, '${statuses[i % 4]}', ${i % 997}, DATE_ADD('2026-01-01', INTERVAL ${i % 300} DAY), NULL)`;
      }).join(',');
      await con.query(`INSERT INTO \`${ORDERS}\` (user_id, status, amount, created_at, note) VALUES ${rows}`);
    }
    await con.query(`ANALYZE TABLE \`${USERS}\`, \`${ORDERS}\``);
  }, 120_000);

  afterAll(async () => {
    if (!con) return;
    try {
      await con.query(`DROP TABLE IF EXISTS \`${ORDERS}\`, \`${USERS}\``);
    } finally {
      await con.end();
    }
  });

  async function plan(sql: string): Promise<ExplainPlan> {
    const [rows] = await con.query({ sql: `EXPLAIN FORMAT=JSON ${sql}`, timeout: 30_000 });
    const parsed = parseMysqlExplain(rows as unknown[]);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.plan;
  }

  function flat(nodes: readonly ExplainPlanNode[]): ExplainPlanNode[] {
    return nodes.flatMap((n) => [n, ...flat(n.children)]);
  }

  function find(p: ExplainPlan, table: string): ExplainPlanNode | undefined {
    return flat(p.roots).find((n) => n.object === table);
  }

  async function advisorTable(name: string): Promise<AdvisorTable> {
    const [cols] = await con.query(
      'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [DB, name],
    ) as [Array<{ name: string; type: string; k: string }>, unknown];
    const [idx] = await con.query(
      'SELECT INDEX_NAME AS name, COLUMN_NAME AS col, NON_UNIQUE AS nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      [DB, name],
    ) as [Array<{ name: string; col: string; nu: number }>, unknown];
    const indexes = new Map<string, { name: string; columns: string[]; isUnique: boolean; isPrimary: boolean }>();
    for (const r of idx) {
      const e = indexes.get(r.name) ?? { name: r.name, columns: [], isUnique: Number(r.nu) === 0, isPrimary: r.name === 'PRIMARY' };
      e.columns.push(r.col);
      indexes.set(r.name, e);
    }
    return {
      name,
      columns: cols.map((c) => ({ name: c.name, type: c.type, isPrimary: c.k === 'PRI', isUnique: c.k === 'UNI' })),
      indexes: [...indexes.values()],
    };
  }

  it('parses a large full scan with a filter and suggests the filter column', async () => {
    const sql = `SELECT * FROM \`${ORDERS}\` WHERE status = 'paid'`;
    const p = await plan(sql);
    const scan = find(p, ORDERS);
    expect(scan?.operation).toBe('Table scan');
    expect(scan?.estimatedRows).toBeGreaterThanOrEqual(1000);
    expect(scan?.warnings).toEqual(expect.arrayContaining(['fullTableScan', 'missingIndex']));
    expect(scan?.filter).toContain('paid');

    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [await advisorTable(ORDERS)] });
    expect(advice.suggestions.map((s) => s.columns)).toEqual([['status']]);
  });

  it('suggests indexes when the SQL uses table aliases (MySQL reports the alias in the plan)', async () => {
    const sql = `SELECT o.id FROM \`${ORDERS}\` o WHERE o.status = 'paid'`;
    const p = await plan(sql);
    expect(flat(p.roots).find((n) => n.object === 'o')?.warnings).toContain('fullTableScan');
    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [await advisorTable(ORDERS)] });
    expect(advice.suggestions.map((s) => [s.table, s.columns])).toEqual([[ORDERS, ['status']]]);
  });

  it('builds an equality → range composite and respects the existing index', async () => {
    const sql = `SELECT id FROM \`${ORDERS}\` WHERE status = 'paid' AND created_at >= '2026-06-01'`;
    const p = await plan(sql);
    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [await advisorTable(ORDERS)] });
    expect(advice.suggestions[0]?.columns).toEqual(['status', 'created_at']);

    const byUser = await plan(`SELECT * FROM \`${ORDERS}\` WHERE user_id = 7`);
    expect(find(byUser, ORDERS)).toMatchObject({ operation: 'Index lookup', index: 'idx_user' });
    expect(byUser.warnings).not.toContain('fullTableScan');
  });

  it('flags filesort and suggests equality + order columns', async () => {
    const sql = `SELECT id FROM \`${ORDERS}\` WHERE status = 'new' ORDER BY amount DESC`;
    const p = await plan(sql);
    expect(p.warnings).toContain('filesort');
    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [await advisorTable(ORDERS)] });
    expect(advice.suggestions[0]?.columns).toEqual(['status', 'amount']);
  });

  it('parses joins and keeps both tables in the tree', async () => {
    const p = await plan(
      `SELECT u.email, o.amount FROM \`${USERS}\` u JOIN \`${ORDERS}\` o ON o.user_id = u.id WHERE u.active = 1`,
    );
    // MySQL 8 reports the alias (not the table name) in `table_name` when one is used.
    const tables = flat(p.roots).map((n) => n.object).filter(Boolean);
    expect(tables.sort()).toEqual(['o', 'u']);
    expect(flat(p.roots).every((n) => typeof n.id === 'string' && n.id.length > 0)).toBe(true);
  });

  it('marks temporary tables for GROUP BY on a non-indexed column', async () => {
    const p = await plan(`SELECT note, COUNT(*) FROM \`${ORDERS}\` GROUP BY note`);
    expect(p.warnings).toEqual(expect.arrayContaining(['temporaryTable']));
  });

  it('excludes primary-key and unique columns from suggestions', async () => {
    const sql = `SELECT * FROM \`${USERS}\` WHERE email = 'u1@x.test'`;
    const p = await plan(sql);
    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [await advisorTable(USERS)] });
    expect(advice.suggestions).toEqual([]);
  });

  it('downgrades low-cardinality TINYINT(1) suggestions', async () => {
    const sql = `SELECT * FROM \`${USERS}\` WHERE active = 1`;
    const p = await plan(sql);
    const advice = suggestIndexes({ plan: p, extraction: extractPredicates(sql), tables: [await advisorTable(USERS)] });
    // 200 rows is below the large-scan threshold, so no suggestion at all is also correct.
    for (const s of advice.suggestions) {
      expect(s.confidence).toBe('low');
      expect(s.risks).toContain('lowCardinality');
    }
  });
});