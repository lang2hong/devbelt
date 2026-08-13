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
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  setResponses(rows: any[]): void {
    this.responses = rows;
    this.idx = 0;
  }
  query(_sql: string, callback?: QueryCallback): void;
  query(_sql: string, values: any, callback?: QueryCallback): void;
  query(_sql: string, values?: any, callback?: any): void {
    const cb = callback || values;
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