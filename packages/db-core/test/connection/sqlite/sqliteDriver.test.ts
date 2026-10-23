import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLite } from '../../../src/connection/sqlite/index';

const HAS_SQLITE = (() => {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
})();

const drivers: SQLite[] = [];

function open(): SQLite {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-drv-'));
  const db = new SQLite(path.join(dir, 'test.db'), 'sqlite3');
  drivers.push(db);
  return db;
}

afterEach(() => {
  for (const d of drivers.splice(0)) {
    try { d.killAll(); } catch { /* already gone */ }
  }
});

/** 单条语句返回单个结果集。 */
function one(res: unknown): { fields: { name: string }[]; rows: Record<string, string>[] } {
  expect(Array.isArray(res)).toBe(false);
  return res as { fields: { name: string }[]; rows: Record<string, string>[] };
}

describe.skipIf(!HAS_SQLITE)('SQLite 常驻进程驱动', () => {
  it('EXPLAIN QUERY PLAN 返回 id/parent/notused/detail 结果集（不被 CLI 改写成 ASCII 树）', async () => {
    const db = open();
    await db.query('CREATE TABLE t(a, b)');
    await db.query('CREATE INDEX ia ON t(a)');
    const r = one(await db.query('EXPLAIN QUERY PLAN SELECT * FROM t WHERE a = 1 ORDER BY b'));
    expect(r.fields.map((f) => f.name)).toEqual(['id', 'parent', 'notused', 'detail']);
    expect(r.rows.map((row) => row.detail)).toEqual(['SEARCH t USING INDEX ia (a=?)', 'USE TEMP B-TREE FOR ORDER BY']);
    // 普通查询输出不受 `.explain off` 影响。
    expect(one(await db.query('SELECT 1 AS x')).rows).toEqual([{ x: '1' }]);
  });

  it('同一进程连续执行多条语句，结果正确', async () => {
    const db = open();
    const r1 = one(await db.query('SELECT 1 AS a, \'x\' AS b, NULL AS c'));
    expect(r1.fields.map((f) => f.name)).toEqual(['a', 'b', 'c']);
    expect(r1.rows).toEqual([{ a: '1', b: 'x', c: 'NULL' }]);

    const r2 = one(await db.query('SELECT 42 AS n'));
    expect(r2.rows).toEqual([{ n: '42' }]);
  });

  it('转义字符串：单引号、双引号、分号', async () => {
    const db = open();
    const r = one(await db.query(`SELECT 'a''b;c' AS v, 'q"q' AS w`));
    expect(r.rows[0].v).toBe("a'b;c");
    expect(r.rows[0].w).toBe('q"q');
  });

  it('错误语句按 -bail 退出进程：本次被拒，下一次查询重建后仍可用', async () => {
    const db = open();
    await expect(db.query('SELECT * FROM nope')).rejects.toThrow(/no such table/);
    const ok = one(await db.query('SELECT 7 AS n'));
    expect(ok.rows).toEqual([{ n: '7' }]);
  });

  it('DML + SELECT changes()（连接层拼接）能读到受影响行数', async () => {
    const db = open();
    await db.query('CREATE TABLE t(a)');
    const res = await db.query('INSERT INTO t(a) VALUES (5); SELECT changes()');
    const list = Array.isArray(res) ? res : [res];
    const changesRow = list[list.length - 1].rows[0] as Record<string, string>;
    expect(Number(Object.values(changesRow)[0])).toBe(1);
  });

  it('并发查询被串行化，互不串扰', async () => {
    const db = open();
    const [r1, r2, r3] = await Promise.all([
      db.query('SELECT 1 AS a'),
      db.query('SELECT 2 AS b'),
      db.query('SELECT 3 AS c'),
    ]);
    expect(one(r1).rows).toEqual([{ a: '1' }]);
    expect(one(r2).rows).toEqual([{ b: '2' }]);
    expect(one(r3).rows).toEqual([{ c: '3' }]);
  });

  it('killAll 后在途查询被拒，下一次查询自动重建进程', async () => {
    const db = open();
    await db.query('SELECT 1 AS a');
    db.killAll();
    const r = one(await db.query('SELECT 9 AS n'));
    expect(r.rows).toEqual([{ n: '9' }]);
  });
});