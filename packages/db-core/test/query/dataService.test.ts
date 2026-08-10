import { describe, expect, it } from 'vitest';
import { DataService } from '../../src/query/dataService';
import { QueryService } from '../../src/query/queryService';
import { IConnection } from '../../src/connection/connection';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import type { QueryCallback } from '../../src/types/query';

/** 内存假连接捕获生成的 SQL */
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
    cb(null, { affectedRows: 1 }, []);
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

describe('DataService（数据编辑）', () => {
  it('生成合法的 UPDATE 语句并转义标识符', async () => {
    const conn = new CaptureConnection();
    const svc = new DataService(new QueryService(conn, new MysqlDialect()));
    await svc.updateCell('users', 'id', 5, 'name', "O'Brien");
    expect(conn.sqls[0]).toBe(
      "UPDATE `users` SET `name` = 'O\\'Brien' WHERE `id` = 5",
    );
  });

  it('NULL 值生成 NULL 字面量', async () => {
    const conn = new CaptureConnection();
    const svc = new DataService(new QueryService(conn, new MysqlDialect()));
    await svc.updateCell('users', 'id', 5, 'deleted_at', null);
    expect(conn.sqls[0]).toBe(
      'UPDATE `users` SET `deleted_at` = NULL WHERE `id` = 5',
    );
  });
});