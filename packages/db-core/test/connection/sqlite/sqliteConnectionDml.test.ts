import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection } from '../../../src/connection/sqliteConnection';
import { QueryService } from '../../../src/query/queryService';
import { SqliteDialect } from '../../../src/dialect/sqliteDialect';

const HAS_SQLITE = (() => {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
})();

/**
 * 连接层 DML 的 affectedRows 拼接，以及 dbPath 的 fail-closed。
 *
 * 受影响的逻辑在 `SqliteConnection`（不是在 SQLite driver）：它会给 DML
 * 追加 `; SELECT changes()`。以 `-- 行注释` 结尾的 SQL 没有换行时会把这句
 * 一起注释掉，affectedRows 恒缺失。
 */
describe.skipIf(!HAS_SQLITE)('SQLite 连接层 DML / dbPath', () => {
  const conns: SqliteConnection[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const c of conns.splice(0)) { try { c.end(); } catch { /* gone */ } }
    for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  function open(fileName = 't.db'): QueryService {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-conn-'));
    dirs.push(dir);
    const conn = new SqliteConnection({ dbPath: path.join(dir, fileName) } as any, 'sqlite3');
    conns.push(conn);
    return new QueryService(conn, new SqliteDialect());
  }

  function openAt(dbPath: string): QueryService {
    const conn = new SqliteConnection({ dbPath } as any, 'sqlite3');
    conns.push(conn);
    return new QueryService(conn, new SqliteDialect());
  }

  it('DML 以行注释结尾时仍能读到 affectedRows（changes() 不被注释吞掉）', async () => {
    const q = open();
    await q.query('CREATE TABLE t(a)');
    const r = await q.query('INSERT INTO t(a) VALUES (5) -- trailing comment');
    expect(r.affectedRows).toBe(1);
  });

  it('含单引号的 dbPath 打开时报明确错误，而非静默打开其它文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-quote-'));
    dirs.push(dir);
    const q = openAt(path.join(dir, "a'b.db"));
    await expect(q.query('SELECT 1')).rejects.toThrow(/must not contain a quote/);
  });
});