import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { SQLite } from '../../../src/connection/sqlite/index';
import { SqliteConnection } from '../../../src/connection/sqliteConnection';
import { QueryService } from '../../../src/query/queryService';
import { SqliteDialect } from '../../../src/dialect/sqliteDialect';
import { BackupService } from '../../../src/query/backupService';

/**
 * Real CLI integration: the SQLite driver spawns one sqlite3 process per query().
 * These tests assert that a single query() carrying BEGIN/COMMIT/ROLLBACK keeps
 * the whole transaction inside one process.
 *
 * 注意：单进程只是原子性的**必要**条件。sqlite3 CLI 从 stdin 读 SQL 时默认不会
 * 在报错处中止（需 `-bail`），因此一条语句失败后它仍会执行到 `COMMIT;`，把先前
 * 的写入提交掉。真正的原子性还欠 `-bail`，见技术文档「遗留」。
 */
describe('SQLite single-process transaction (real sqlite3 CLI)', () => {
  const dbPath = path.join(os.tmpdir(), `db-transfer-${Date.now()}.db`);

  it('commits a batch of statements sent in one query', async () => {
    const sqlite = new SQLite(dbPath, 'sqlite3');
    await sqlite.query('CREATE TABLE t(id INTEGER, name TEXT);');
    await sqlite.query("BEGIN; INSERT INTO t VALUES(1,'a'); INSERT INTO t VALUES(2,'b'); COMMIT;");
    const result = await sqlite.query('SELECT COUNT(*) AS c FROM t;');
    expect(Number((result as any).rows[0].c)).toBe(2);
  });

  it('rolls back statements sent in one query when the transaction is rolled back', async () => {
    const sqlite = new SQLite(dbPath, 'sqlite3');
    await sqlite.query("BEGIN; INSERT INTO t VALUES(3,'c'); INSERT INTO t VALUES(4,'d'); ROLLBACK;");
    const result = await sqlite.query('SELECT COUNT(*) AS c FROM t;');
    expect(Number((result as any).rows[0].c)).toBe(2);
  });

  it('drops BEGIN when statements are sent as separate queries (the reason for singleStatement)', async () => {
    const sqlite = new SQLite(dbPath, 'sqlite3');
    // 分开发送：BEGIN 随第一个进程退出即失效，后续 INSERT 自动提交
    await sqlite.query('BEGIN;');
    await sqlite.query("INSERT INTO t VALUES(5,'e');");
    // 新进程里已无活动事务，ROLLBACK 直接报错 —— 逐句执行拿不到事务语义
    await expect(sqlite.query('ROLLBACK;')).rejects.toThrow('no transaction is active');
    const result = await sqlite.query('SELECT COUNT(*) AS c FROM t;');
    // 那一行留了下来，ROLLBACK 什么也没撤销
    expect(Number((result as any).rows[0].c)).toBe(3);
  });
});

describe('SqliteConnection.beginTransaction', () => {
  it('fails explicitly instead of pretending the transaction started', async () => {
    const conn = new SqliteConnection({ dbPath: '/tmp/never-opened.db' } as any, 'sqlite3');
    const err = await new Promise<any>((resolve) => conn.beginTransaction(resolve));
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('does not support multi-statement transactions');
  });
});

describe('BackupService.restore singleStatement (real sqlite3 CLI)', () => {
  function makeQuery(dbPath: string): QueryService {
    const conn = new SqliteConnection({ dbPath } as any, 'sqlite3');
    return new QueryService(conn, new SqliteDialect());
  }

  async function countRows(dbPath: string): Promise<number> {
    const sqlite = new SQLite(dbPath, 'sqlite3');
    const result = await sqlite.query('SELECT COUNT(*) AS c FROM r;');
    return Number((result as any).rows[0].c);
  }

  it('applies the whole dump atomically', async () => {
    const dbPath = path.join(os.tmpdir(), `db-restore-ok-${Date.now()}.db`);
    const query = makeQuery(dbPath);
    await query.query('CREATE TABLE r(id INTEGER);');

    const res = await BackupService.restore(
      query,
      ['INSERT INTO r VALUES(1)', 'INSERT INTO r VALUES(2)', 'INSERT INTO r VALUES(3)'],
      { singleStatement: true },
    );

    expect(res.completed).toBe(3);
    expect(await countRows(dbPath)).toBe(3);
  });

  it('sends the batch as one process-local transaction', async () => {
    const dbPath = path.join(os.tmpdir(), `db-restore-one-${Date.now()}.db`);
    const query = makeQuery(dbPath);
    await query.query('CREATE TABLE r(id INTEGER);');

    // 批处理内的显式 ROLLBACK 生效 → 证明 BEGIN 与后续语句确实在同一进程
    await query.query('BEGIN;\nINSERT INTO r VALUES(1);\nROLLBACK;');

    expect(await countRows(dbPath)).toBe(0);
  });
});