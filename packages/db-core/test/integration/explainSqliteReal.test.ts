import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractPredicates, parseSqliteExplain, suggestIndexes } from '@devbelt/explain-core';
import type { ExplainPlan, ExplainPlanNode } from '@devbelt/explain-core';
import { SQLite } from '../../src/connection/sqlite/index';

/**
 * P10 S9: real SQLite plans through the db-core driver → explain-core.
 *
 * Uses a throw-away database file; skipped when the sqlite3 CLI is missing.
 */
const HAS_SQLITE = (() => {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
})();

const drivers: Array<{ db: SQLite; dir: string }> = [];

async function open(): Promise<SQLite> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-eqp-'));
  const db = new SQLite(path.join(dir, 'p10.db'), 'sqlite3');
  drivers.push({ db, dir });
  await db.query(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, active INTEGER)`);
  await db.query(`CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT, created_at TEXT)`);
  await db.query(`CREATE INDEX idx_orders_user ON orders(user_id)`);
  return db;
}

afterEach(() => {
  for (const { db, dir } of drivers.splice(0)) {
    try { db.killAll(); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function plan(db: SQLite, sql: string): Promise<ExplainPlan> {
  const res = await db.query(`EXPLAIN QUERY PLAN ${sql}`) as { rows: unknown[] };
  expect(res.rows.length).toBeGreaterThan(0);
  const parsed = parseSqliteExplain(res.rows);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.plan;
}

function flat(nodes: readonly ExplainPlanNode[]): ExplainPlanNode[] {
  return nodes.flatMap((n) => [n, ...flat(n.children)]);
}

describe.skipIf(!HAS_SQLITE)('P10 EXPLAIN on real SQLite', () => {
  it('reports a full scan and suggests an index for the filter column', async () => {
    const db = await open();
    const sql = "SELECT * FROM orders WHERE status = 'paid'";
    const p = await plan(db, sql);
    const scan = flat(p.roots).find((n) => n.operation === 'Table scan');
    expect(scan).toMatchObject({ object: 'orders', warnings: ['fullTableScan'] });

    const advice = suggestIndexes({
      plan: p,
      extraction: extractPredicates(sql),
      tables: [{
        name: 'orders',
        columns: [{ name: 'id', isPrimary: true }, { name: 'user_id' }, { name: 'status' }, { name: 'created_at' }],
        indexes: [{ name: 'idx_orders_user', columns: ['user_id'] }],
      }],
    });
    expect(advice.suggestions.map((s) => s.columns)).toEqual([['status']]);
  });

  it('suggests indexes when the SQL uses table aliases (SQLite reports the alias in the plan)', async () => {
    const db = await open();
    const sql = "SELECT o.id FROM orders o WHERE o.status = 'paid'";
    const p = await plan(db, sql);
    expect(flat(p.roots).find((n) => n.object === 'o')?.warnings).toEqual(['fullTableScan']);
    const advice = suggestIndexes({
      plan: p,
      extraction: extractPredicates(sql),
      tables: [{
        name: 'orders',
        columns: [{ name: 'id', isPrimary: true }, { name: 'user_id' }, { name: 'status' }, { name: 'created_at' }],
        indexes: [{ name: 'idx_orders_user', columns: ['user_id'] }],
      }],
    });
    expect(advice.suggestions.map((s) => [s.table, s.columns])).toEqual([['orders', ['status']]]);
  });

  it('recognises index search, primary-key lookup and temp B-tree sort', async () => {
    const db = await open();
    const byIndex = flat((await plan(db, 'SELECT * FROM orders WHERE user_id = 1 ORDER BY created_at')).roots);
    expect(byIndex.map((n) => n.operation)).toEqual(['Index search', 'Temporary B-tree (ORDER BY)']);
    expect(byIndex[0]).toMatchObject({ object: 'orders', index: 'idx_orders_user', indexCondition: 'user_id=?' });
    expect(byIndex[1].warnings).toEqual(['filesort']);

    const byPk = flat((await plan(db, 'SELECT * FROM users WHERE id = 1')).roots);
    expect(byPk[0]).toMatchObject({ operation: 'Primary key lookup', object: 'users' });
  });

  it('builds a tree for joins and correlated sub-queries', async () => {
    const db = await open();
    const p = await plan(
      db,
      'SELECT u.email FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id IN (SELECT user_id FROM orders WHERE status = 1)',
    );
    // Real SQLite 3.45 output: PK lookup on u, LIST SUBQUERY with a child SCAN, covering index on o.
    expect(p.roots.map((n) => n.operation)).toEqual(['Primary key lookup', 'List subquery', 'Covering index search']);
    expect(p.roots[1].children.map((n) => n.operation)).toEqual(['Table scan']);
    expect(p.roots[2]).toMatchObject({ object: 'o', index: 'idx_orders_user' });
    // Every node has a stable id and the tree is non-empty.
    expect(new Set(flat(p.roots).map((n) => n.id)).size).toBe(flat(p.roots).length);
  });

  it('treats a constant query without warnings', async () => {
    const db = await open();
    const p = await plan(db, 'SELECT 1');
    expect(p.roots[0]).toMatchObject({ operation: 'Constant row', warnings: [] });
  });
});