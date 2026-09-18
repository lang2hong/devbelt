import { describe, expect, it } from 'vitest';
import { QueryService, type QueryCancelToken } from '../../src/query/queryService';
import { IConnection } from '../../src/connection/connection';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import type { QueryCallback } from '../../src/types/query';

/** 挂起式假连接：query 不立即回调，由测试手动 settle，用于验证取消语义。 */
class PendingConnection extends IConnection {
  aborts = 0;
  private readonly pending: Array<{ cb: QueryCallback; fields: any[] }> = [];

  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }

  query(_sql: string, valuesOrCb?: any, maybeCb?: any): void {
    const cb = (typeof valuesOrCb === 'function' ? valuesOrCb : maybeCb) as QueryCallback;
    this.pending.push({ cb, fields: [{ name: 'n' }] });
  }

  connect(cb: (err: any) => void): void { cb(null); }
  beginTransaction(cb: (err: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
  abortQuery(): void { this.aborts++; }

  settle(index: number, rows: any[]): void {
    this.pending[index].cb(null, rows, this.pending[index].fields);
  }
}

describe('QueryService 按查询取消', () => {
  it('token 只取消对应查询，不牵连同会话其它在途查询', async () => {
    const conn = new PendingConnection();
    const svc = new QueryService(conn, new MysqlDialect());

    const t1: QueryCancelToken = {};
    const p1 = svc.query('SELECT 1', undefined, { token: t1 });
    const p2 = svc.query('SELECT 2');
    p1.catch(() => {});

    expect(typeof t1.cancel).toBe('function');
    t1.cancel!();
    await expect(p1).rejects.toThrow(/cancelled/i);

    // 另一条查询不受影响，仍能正常返回。
    conn.settle(1, [{ n: 2 }]);
    await expect(p2).resolves.toMatchObject({ rows: [{ n: 2 }] });
  });

  it('会话级 cancel 对每个在途查询各中止一次，不重复 abort', async () => {
    const conn = new PendingConnection();
    const svc = new QueryService(conn, new MysqlDialect());

    const p1 = svc.query('SELECT 1');
    const p2 = svc.query('SELECT 2');
    p1.catch(() => {});
    p2.catch(() => {});

    expect(svc.cancel()).toBe(true);
    // 会话级取消只对该物理连接中止一次（不再每个在途查询各中止一次）。
    expect(conn.aborts).toBe(1);
  });
});
describe('QueryService 会话级超时覆盖', () => {
  it('会话级 timeoutMs 覆盖全局默认并按该值超时', async () => {
    const conn = new PendingConnection();
    const svc = new QueryService(conn, new MysqlDialect(), undefined, 5);
    await expect(svc.query('SELECT 1')).rejects.toThrow(/timeout \(5ms\)/);
    expect(conn.aborts).toBe(1);
  });
});
