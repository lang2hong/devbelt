import { describe, expect, it } from 'vitest';
import { QueryService } from './queryService';
import { IConnection } from '../connection/connection';
import { MysqlDialect } from '../dialect/mysqlDialect';
import type { QueryCallback } from '../types/query';

/** 内存假连接，用于不依赖真实数据库测试查询服务 */
class FakeConnection extends IConnection {
  public executed: string[] = [];
  public result: any = { rows: [{ id: 1 }] };
  public fields: any[] = [{ name: 'id' }];

  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }

  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.executed.push(sql);
    const cb = callback || values;
    cb(null, this.result, this.fields);
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

describe('QueryService（查询执行）', () => {
  it('将回调风格查询统一为 Promise<QueryResult>', async () => {
    const conn = new FakeConnection();
    const svc = new QueryService(conn, new MysqlDialect());
    const res = await svc.query('SELECT * FROM users');
    expect(res.rows).toEqual([{ id: 1 }]);
    expect(res.fields).toEqual([{ name: 'id' }]);
    expect(res.costTime).toBeGreaterThanOrEqual(0);
  });

  it('分页查询复用方言生成 SQL', async () => {
    const conn = new FakeConnection();
    const svc = new QueryService(conn, new MysqlDialect());
    await svc.queryPage('SELECT * FROM users', 20, 10);
    expect(conn.executed[0]).toBe('SELECT * FROM users LIMIT 20, 10');
  });

  it('DML 返回受影响行数', async () => {
    const conn = new FakeConnection();
    conn.result = { affectedRows: 3 };
    const svc = new QueryService(conn, new MysqlDialect());
    const res = await svc.query('DELETE FROM users');
    expect(res.affectedRows).toBe(3);
  });

  it('查询失败封装为 QueryError', async () => {
    const conn = new FakeConnection();
    conn.query = (_sql: string, values?: any, callback?: any) => {
      const cb = callback || values;
      cb(new Error('syntax error'));
    };
    const svc = new QueryService(conn, new MysqlDialect());
    await expect(svc.query('BAD SQL')).rejects.toThrowError('syntax error');
  });
});