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
    await svc.updateCell('users', ['id'], [5], 'name', "O'Brien");
    expect(conn.sqls[0]).toBe(
      "UPDATE `users` SET `name` = 'O\\'Brien' WHERE `id` = 5",
    );
  });

  it('NULL 值生成 NULL 字面量', async () => {
    const conn = new CaptureConnection();
    const svc = new DataService(new QueryService(conn, new MysqlDialect()));
    await svc.updateCell('users', ['id'], [5], 'deleted_at', null);
    expect(conn.sqls[0]).toBe(
      'UPDATE `users` SET `deleted_at` = NULL WHERE `id` = 5',
    );
  });

  it('insertRow 生成合法的 INSERT 并转义值', async () => {
    const conn = new CaptureConnection();
    const svc = new DataService(new QueryService(conn, new MysqlDialect()));
    await svc.insertRow('users', ['id', 'name', 'email'], [null, "O'Brien", 'a@b.com'], 'test');
    expect(conn.sqls[0]).toBe(
      "INSERT INTO `test`.`users` (`id`, `name`, `email`) VALUES (NULL, 'O\\'Brien', 'a@b.com')",
    );
  });

  it('deleteRows 生成多行 OR 删除', async () => {
    const conn = new CaptureConnection();
    const svc = new DataService(new QueryService(conn, new MysqlDialect()));
    await svc.deleteRows('users', ['id'], [[1], [2], [3]], 'test');
    expect(conn.sqls[0]).toBe(
      'DELETE FROM `test`.`users` WHERE (`id` = 1) OR (`id` = 2) OR (`id` = 3)',
    );
  });

  it('复合主键 updateCell 生成 AND 条件', async () => {
    const conn = new CaptureConnection();
    const svc = new DataService(new QueryService(conn, new MysqlDialect()));
    await svc.updateCell('orders', ['tenant_id', 'order_no'], [7, 'A123'], 'status', 'paid');
    expect(conn.sqls[0]).toBe(
      "UPDATE `orders` SET `status` = 'paid' WHERE `tenant_id` = 7 AND `order_no` = 'A123'",
    );
  });

  it('复合主键 deleteRows 生成 AND+OR 条件', async () => {
    const conn = new CaptureConnection();
    const svc = new DataService(new QueryService(conn, new MysqlDialect()));
    await svc.deleteRows('orders', ['tenant_id', 'order_no'], [[7, 'A123'], [7, 'B456']]);
    expect(conn.sqls[0]).toBe(
      "DELETE FROM `orders` WHERE (`tenant_id` = 7 AND `order_no` = 'A123') OR (`tenant_id` = 7 AND `order_no` = 'B456')",
    );
  });
});