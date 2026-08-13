import { describe, expect, it } from 'vitest';
import { BackupService } from '../../src/query/backupService';
import { QueryService } from '../../src/query/queryService';
import type { MetadataService } from '../../src/query/metadataService';
import type { TableService } from '../../src/query/tableService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import { IConnection } from '../../src/connection/connection';
import type { QueryCallback } from '../../src/types/query';

class FakeConnection extends IConnection {
  private responses: any[] = [];
  private idx = 0;
  /** 收到的全部 SQL，供 restore 用例断言批处理拼装 */
  readonly executed: string[] = [];
  /** 命中该子串的 SQL 会失败，模拟 dump 中途报错 */
  failOn?: string;
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  setResponses(rows: any[]): void {
    this.responses = rows;
    this.idx = 0;
  }
  query(_sql: string, callback?: QueryCallback): void;
  query(_sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    const cb = callback || values;
    this.executed.push(sql);
    if (this.failOn && sql.includes(this.failOn)) {
      cb(new Error(`syntax error near "${this.failOn}"`));
      return;
    }
    const r = this.responses[this.idx] || { rows: [] };
    this.idx++;
    cb(null, r, []);
  }
  connect(cb: (err: any) => void): void { cb(null); }
  beginTransaction(cb: (err: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

function makeQueryService(conn: FakeConnection, dialect: MysqlDialect | PostgreSqlDialect | SqliteDialect): QueryService {
  return new QueryService(conn, dialect);
}

function makeMetadataService(): MetadataService {
  return {
    getTables: async () => [{ name: 'users' }],
    getColumns: async () => [{ name: 'id' }, { name: 'name' }],
  } as unknown as MetadataService;
}

function makeTableService(): TableService {
  return {
    getCreateSql: async () => 'CREATE TABLE `users` (\n  `id` int(11) NOT NULL,\n  `name` varchar(255) DEFAULT NULL\n) ENGINE=InnoDB',
  } as unknown as TableService;
}

describe('BackupService', () => {
  it('databaseDump 生成完整 MySQL dump（含 prelude/epilogue）', async () => {
    const conn = new FakeConnection();
    conn.setResponses([
      { rows: [{ id: 1, name: 'Alice' }] },
    ]);
    const query = makeQueryService(conn, new MysqlDialect());
    const meta = makeMetadataService();
    const tableService = makeTableService();

    const dump = await BackupService.databaseDump(query, meta, tableService, 'test', { includeData: true });
    expect(dump).toContain('-- DB Client Pro Dump');
    expect(dump).toContain('-- Server Type: MYSQL');
    expect(dump).toContain('SET NAMES utf8mb4');
    expect(dump).toContain('SET FOREIGN_KEY_CHECKS = 0');
    expect(dump).toContain('DROP TABLE IF EXISTS');
    expect(dump).toContain('CREATE TABLE');
    expect(dump).toContain('INSERT INTO');
    expect(dump).toContain('SET FOREIGN_KEY_CHECKS = 1');
  });

  it('databaseDump 生成完整 PG dump', async () => {
    const conn = new FakeConnection();
    conn.setResponses([{ rows: [] }]);
    const query = makeQueryService(conn, new PostgreSqlDialect());
    const meta = makeMetadataService();
    const tableService = {
      getCreateSql: async () => 'CREATE TABLE "users" (\n  "id" int NOT NULL\n)',
    } as unknown as TableService;

    const dump = await BackupService.databaseDump(query, meta, tableService, 'test', { includeData: false });
    expect(dump).toContain('-- Server Type: PG');
    expect(dump).toContain('SET client_encoding');
    expect(dump).toContain('SET session_replication_role = \'replica\'');
    expect(dump).toContain('SET session_replication_role = \'origin\'');
  });

  it('databaseDump 生成完整 SQLite dump', async () => {
    const conn = new FakeConnection();
    conn.setResponses([{ rows: [] }]);
    const query = makeQueryService(conn, new SqliteDialect());
    const meta = makeMetadataService();
    const tableService = {
      getCreateSql: async () => 'CREATE TABLE "users" (\n  "id" INTEGER NOT NULL\n)',
    } as unknown as TableService;

    const dump = await BackupService.databaseDump(query, meta, tableService, 'test', { includeData: false });
    expect(dump).toContain('-- Server Type: SQLITE');
    expect(dump).toContain('PRAGMA foreign_keys = OFF');
    expect(dump).toContain('PRAGMA foreign_keys = ON');
  });

  it('includeData=false 不生成 INSERT 语句', async () => {
    const conn = new FakeConnection();
    conn.setResponses([{ rows: [{ id: 1, name: 'Alice' }] }]);
    const query = makeQueryService(conn, new MysqlDialect());
    const meta = makeMetadataService();
    const tableService = makeTableService();

    const dump = await BackupService.databaseDump(query, meta, tableService, 'test', { includeData: false });
    expect(dump).not.toContain('INSERT INTO');
  });

  it('取消回调中止 dump', async () => {
    const conn = new FakeConnection();
    conn.setResponses([{ rows: [{ id: 1 }] }]);
    const query = makeQueryService(conn, new MysqlDialect());
    const meta = makeMetadataService();
    const tableService = makeTableService();

    await expect(
      BackupService.databaseDump(query, meta, tableService, 'test', {
        includeData: true,
        isCancelled: () => true,
      }),
    ).rejects.toThrow('Backup cancelled');
  });

  it('进度回调正确触发', async () => {
    const conn = new FakeConnection();
    conn.setResponses([{ rows: [] }]);
    const query = makeQueryService(conn, new MysqlDialect());
    const meta = makeMetadataService();
    const tableService = makeTableService();
    const progress: { table: string; completed: number; total: number }[] = [];

    await BackupService.databaseDump(query, meta, tableService, 'test', {
      includeData: false,
      onProgress: (p) => progress.push(p),
    });
    expect(progress.length).toBeGreaterThanOrEqual(1);
    const last = progress[progress.length - 1];
    expect(last.completed).toBe(last.total);
  });
});

describe('BackupService.restore — 逐句路径（默认）', () => {
  const statements = ['INSERT INTO a VALUES (1)', 'INSERT INTO a VALUES (2)'];

  it('用 BEGIN/COMMIT 包裹并逐条执行', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new MysqlDialect());

    const res = await BackupService.restore(query, statements);

    expect(conn.executed).toEqual([
      'BEGIN',
      'INSERT INTO a VALUES (1)',
      'INSERT INTO a VALUES (2)',
      'COMMIT',
    ]);
    expect(res.completed).toBe(2);
    expect(res.total).toBe(2);
  });

  it('逐条上报进度', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new MysqlDialect());
    const seen: number[] = [];

    await BackupService.restore(query, statements, { onProgress: (p) => seen.push(p.completed) });

    expect(seen).toEqual([1, 2]);
  });

  it('中途失败时回滚并抛错，进度里带 error', async () => {
    const conn = new FakeConnection();
    conn.failOn = 'VALUES (2)';
    const query = makeQueryService(conn, new MysqlDialect());
    const errors: (string | undefined)[] = [];

    await expect(
      BackupService.restore(query, statements, { onProgress: (p) => errors.push(p.error) }),
    ).rejects.toThrow('syntax error');

    expect(conn.executed).toContain('ROLLBACK');
    expect(errors.filter(Boolean)).toHaveLength(1);
  });

  it('取消回调中止并回滚', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new MysqlDialect());

    await expect(
      BackupService.restore(query, statements, { isCancelled: () => true }),
    ).rejects.toThrow('Restore cancelled');

    expect(conn.executed).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('跳过空白语句', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new MysqlDialect());

    await BackupService.restore(query, ['INSERT INTO a VALUES (1)', '   ', '']);

    expect(conn.executed).toEqual(['BEGIN', 'INSERT INTO a VALUES (1)', 'COMMIT']);
  });
});

describe('BackupService.restore — singleStatement 路径（SQLite）', () => {
  it('把整批拼成一条 BEGIN; …; COMMIT; 只发一次', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new SqliteDialect());

    const res = await BackupService.restore(
      query,
      ['INSERT INTO a VALUES (1)', 'INSERT INTO a VALUES (2)'],
      { singleStatement: true },
    );

    expect(conn.executed).toHaveLength(1);
    expect(conn.executed[0]).toBe(
      'BEGIN;\nINSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2);\nCOMMIT;',
    );
    expect(res.completed).toBe(2);
    expect(res.total).toBe(2);
  });

  it('不重复已有的分号', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new SqliteDialect());

    await BackupService.restore(query, ['INSERT INTO a VALUES (1);'], { singleStatement: true });

    expect(conn.executed[0]).toBe('BEGIN;\nINSERT INTO a VALUES (1);\nCOMMIT;');
    expect(conn.executed[0]).not.toContain(';;');
  });

  it('过滤空白语句后再计数', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new SqliteDialect());

    const res = await BackupService.restore(
      query,
      ['  INSERT INTO a VALUES (1)  ', '', '   ', '\n'],
      { singleStatement: true },
    );

    expect(res.total).toBe(1);
    expect(conn.executed[0]).toBe('BEGIN;\nINSERT INTO a VALUES (1);\nCOMMIT;');
  });

  it('全空输入时不发任何 SQL', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new SqliteDialect());

    const res = await BackupService.restore(query, ['', '  '], { singleStatement: true });

    expect(conn.executed).toEqual([]);
    expect(res).toEqual({ statement: '', completed: 0, total: 0 });
  });

  it('失败时抛出原始错误，且不补发 ROLLBACK（进程退出已隐式回滚）', async () => {
    const conn = new FakeConnection();
    conn.failOn = 'BEGIN;';
    const query = makeQueryService(conn, new SqliteDialect());

    await expect(
      BackupService.restore(query, ['INSERT INTO a VALUES (1)'], { singleStatement: true }),
    ).rejects.toThrow('syntax error');

    // 只发了那一条批处理；补发的 ROLLBACK 会落在新进程上，只能得到
    // "no transaction is active"
    expect(conn.executed).toHaveLength(1);
    expect(conn.executed[0]).toContain('BEGIN;');
  });

  it('失败时上报带 error 的进度', async () => {
    const conn = new FakeConnection();
    conn.failOn = 'BEGIN;';
    const query = makeQueryService(conn, new SqliteDialect());
    const seen: (string | undefined)[] = [];

    await expect(
      BackupService.restore(query, ['INSERT INTO a VALUES (1)'], {
        singleStatement: true,
        onProgress: (p) => seen.push(p.error),
      }),
    ).rejects.toThrow();

    expect(seen.filter(Boolean)).toHaveLength(1);
  });

  it('取消回调在发送前生效', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new SqliteDialect());

    await expect(
      BackupService.restore(query, ['INSERT INTO a VALUES (1)'], {
        singleStatement: true,
        isCancelled: () => true,
      }),
    ).rejects.toThrow('Restore cancelled');

    expect(conn.executed).toEqual([]);
  });

  it('成功后上报一次终态进度', async () => {
    const conn = new FakeConnection();
    const query = makeQueryService(conn, new SqliteDialect());
    const seen: Array<{ completed: number; total: number }> = [];

    await BackupService.restore(query, ['A', 'B', 'C'], {
      singleStatement: true,
      onProgress: (p) => seen.push({ completed: p.completed, total: p.total }),
    });

    expect(seen).toEqual([{ completed: 3, total: 3 }]);
  });
});