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

/**
 * sqlite3 CLI 的 `-bail` 缺陷实证（不加该参数时批处理非原子）：
 *
 * sqlite3 从 stdin 读 SQL 默认在**语法错误处不中止**，而是打印错误后继续执行到
 * `COMMIT;`。因此 `BEGIN; INSERT A; INSERT B; INSERT bad; COMMIT;` 会把 A、B
 * 提交掉。`SQLite.query` 当前 spawn 参数（[-header,-nullvalue,-cmd,.mode tcl]）
 * 不含 `-bail`，所以同样的问题存在于：
 *  - BackupService.restore 的 singleStatement（F33 只保证事务不被进程边界切断）
 *  - importService.importRowsBatched 声称的「事务原子性」
 *
 * 加 `-bail` 后失败即中止并回滚，残留 0 行。此对照把缺陷固定为可回归验证。
 */
describe('sqlite3 CLI -bail 影响事务原子性', () => {
  const sql = 'CREATE TABLE t(id INTEGER);\nBEGIN;\nINSERT INTO t VALUES(1);\nINSERT INTO t VALUES(2);\nINSERT INTO bad;\nCOMMIT;\n';

  it('不带 -bail（当前 SQLite.query 行为）：坏语句被跳过，先前写入被提交', async () => {
    const db = path.join(os.tmpdir(), `bail-nobail-${Date.now()}.db`);
    const { execFileSync } = await import('child_process');
    // 语法错误会 print 到 stderr，写入失败符合预期；命令整体不抛因为坏语句不是强制错误码
    try {
      execFileSync('sqlite3', [db], { input: sql, encoding: 'utf8' });
    } catch { /* stderr 里的语法错误是预期的 */ }
    const out = execFileSync('sqlite3', [db, 'SELECT COUNT(*) FROM t;'], { encoding: 'utf8' }).trim();
    expect(out).toBe('2');
  });

  it('带 -bail：失败即中止并回滚，残留 0 行', async () => {
    const db = path.join(os.tmpdir(), `bail-yes-${Date.now()}.db`);
    const { execFileSync } = await import('child_process');
    try {
      execFileSync('sqlite3', ['-bail', db], { input: sql, encoding: 'utf8' });
    } catch { /* bad 语句导致 -bail 中止退出码非 0，符合预期 */ }
    const out = execFileSync('sqlite3', [db, 'SELECT COUNT(*) FROM t;'], { encoding: 'utf8' }).trim();
    expect(out).toBe('0');
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

describe('SqliteConnection DML affectedRows (real sqlite3 CLI)', () => {
  function makeQuery(dbPath: string): QueryService {
    const conn = new SqliteConnection({ dbPath } as any, 'sqlite3');
    return new QueryService(conn, new SqliteDialect());
  }

  it('INSERT/UPDATE/DELETE 返回真实受影响行数', async () => {
    const dbPath = path.join(os.tmpdir(), `db-dml-${Date.now()}.db`);
    const query = makeQuery(dbPath);
    await query.query('CREATE TABLE t(id INTEGER, name TEXT);');

    const ins = await query.query("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c');");
    expect(ins.affectedRows).toBe(3);

    const upd = await query.query("UPDATE t SET name='x' WHERE id <= 2;");
    expect(upd.affectedRows).toBe(2);

    const del = await query.query('DELETE FROM t WHERE id = 1;');
    expect(del.affectedRows).toBe(1);
  });

  it('SELECT 不返回 affectedRows', async () => {
    const dbPath = path.join(os.tmpdir(), `db-select-${Date.now()}.db`);
    const query = makeQuery(dbPath);
    await query.query('CREATE TABLE t(id INTEGER);');
    await query.query("INSERT INTO t VALUES (1);");
    const sel = await query.query('SELECT * FROM t;');
    expect(sel.affectedRows).toBeUndefined();
    expect(sel.rows.length).toBe(1);
  });

  /**
   * 回归：**不带结尾分号**的 DML 必须照样执行。
   *
   * 追加 `SELECT changes()` 时若不补分号，拼出的是
   * `INSERT INTO t VALUES(1) SELECT changes()` —— sqlite3 报
   * `Parse error near "SELECT"`。而 DataService 生成的 UPDATE/DELETE/INSERT
   * 全都不带结尾分号（updateCell/deleteRows/insertRow），于是 SQLite 上的
   * 单元格编辑、插入行、删除行全部失败。此前的用例恰好每条都自带分号，
   * 把这个缺陷完整掩盖了。
   */
  it('无结尾分号的 DML（DataService 的真实形状）仍返回受影响行数', async () => {
    const dbPath = path.join(os.tmpdir(), `db-nosemi-${Date.now()}.db`);
    const query = makeQuery(dbPath);
    await query.query('CREATE TABLE t(id INTEGER, name TEXT);');

    const ins = await query.query("INSERT INTO t (id, name) VALUES (1, 'a')");
    expect(ins.affectedRows).toBe(1);

    const ins2 = await query.query("INSERT INTO t (id, name) VALUES (2, 'b')");
    expect(ins2.affectedRows).toBe(1);

    const upd = await query.query("UPDATE t SET name = 'x' WHERE id = 1");
    expect(upd.affectedRows).toBe(1);

    const del = await query.query('DELETE FROM t WHERE id = 2');
    expect(del.affectedRows).toBe(1);

    const rest = await query.query('SELECT id, name FROM t');
    expect(rest.rows.length).toBe(1);
    expect(String(rest.rows[0].name)).toBe('x');
  });

  it('结尾分号后带空白的 DML 也不会拼错', async () => {
    const dbPath = path.join(os.tmpdir(), `db-semiws-${Date.now()}.db`);
    const query = makeQuery(dbPath);
    await query.query('CREATE TABLE t(id INTEGER);');
    const ins = await query.query('INSERT INTO t VALUES (1);  \n');
    expect(ins.affectedRows).toBe(1);
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