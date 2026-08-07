import { describe, expect, it } from 'vitest';
import { TableService } from './tableService';
import { QueryService } from './queryService';
import { IConnection } from '../connection/connection';
import { MysqlDialect } from '../dialect/mysqlDialect';
import type { QueryCallback } from '../types/query';

/** 内存假连接捕获 SQL */
class CaptureConnection extends IConnection {
  public sqls: string[] = [];
  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }
  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.sqls.push(sql);
    const cb = callback || values;
    cb(null, { rows: [], affectedRows: 1 }, []);
  }
  connect(cb: (err: any) => void): void {
    cb(null);
  }
  beginTransaction(cb: (err: any) => void): void {
    cb(null);
  }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean {
    return true;
  }
}

describe('TableService（表操作）', () => {
  it('生成 DROP TABLE 并转义标识符', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.dropTable('users');
    expect(conn.sqls[0]).toBe('DROP TABLE `users`');
  });

  it('生成 RENAME TABLE', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.renameTable('users', 'accounts');
    expect(conn.sqls[0]).toBe('RENAME TABLE `users` TO `accounts`');
  });

  it('生成 TRUNCATE TABLE', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.truncateTable('users');
    expect(conn.sqls[0]).toBe('TRUNCATE TABLE `users`');
  });

  it('生成建表语句查询（MySQL）', async () => {
    const conn = new CaptureConnection();
    const svc = new TableService(new QueryService(conn, new MysqlDialect()));
    await svc.getCreateSql('users');
    expect(conn.sqls[0]).toBe('SHOW CREATE TABLE `users`');
  });
});