import { describe, expect, it } from 'vitest';
import { QueryService } from '../../src/query/queryService';
import type { ExecutedStatement } from '../../src/query/queryService';
import { IConnection } from '../../src/connection/connection';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import type { QueryCallback } from '../../src/types/query';

/** 内存假连接，用于不依赖真实数据库测试查询服务 */
class FakeConnection extends IConnection {
  public executed: string[] = [];
  public result: any = { rows: [{ id: 1 }] };
  public fields: any[] = [{ name: 'id' }];
  public error: Error | null = null;
  /** true 时不回调（模拟挂起），用于超时/取消路径。 */
  public hang = false;

  constructor() {
    super({ host: 'localhost', port: 3306, user: 'root', database: 'test' });
  }

  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: string, values?: any, callback?: any): void {
    this.executed.push(sql);
    if (this.hang) return;
    const cb = callback || values;
    cb(this.error, this.result, this.fields);
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

  it('分页入参归一：NaN/负数/小数/Infinity 不产生非法 LIMIT', async () => {
    const conn = new FakeConnection();
    const svc = new QueryService(conn, new MysqlDialect());

    await svc.queryPage('SELECT 1', Number.NaN, Number.NaN);
    expect(conn.executed.at(-1)).toBe('SELECT 1 LIMIT 0, 10000');

    await svc.queryPage('SELECT 1', -5, -3);
    expect(conn.executed.at(-1)).toBe('SELECT 1 LIMIT 0, 1');

    await svc.queryPage('SELECT 1', 10.9, 5.9);
    expect(conn.executed.at(-1)).toBe('SELECT 1 LIMIT 10, 5');

    await svc.queryPage('SELECT 1', Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    expect(conn.executed.at(-1)).toBe('SELECT 1 LIMIT 0, 10000');
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

/**
 * 观察者是查询历史的挂载点：所有经过 QueryService 的语句都要流过它，
 * 否则「记录每一条修改性 SQL」就退化成在几十个调用点逐个补写 history.add，
 * 每加一个新命令漏一次。
 */
describe('QueryService 语句观察者', () => {
  it('成功执行时上报 SQL、耗时与行数', async () => {
    const conn = new FakeConnection();
    const seen: ExecutedStatement[] = [];
    const svc = new QueryService(conn, new MysqlDialect(), (info) => seen.push(info));
    await svc.query('SELECT * FROM users');
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toBe('SELECT * FROM users');
    expect(seen[0].rowCount).toBe(1);
    expect(seen[0].costTime).toBeGreaterThanOrEqual(0);
    expect(seen[0].error).toBeUndefined();
  });

  it('写语句上报 affectedRows', async () => {
    const conn = new FakeConnection();
    conn.result = { affectedRows: 7 };
    const seen: ExecutedStatement[] = [];
    const svc = new QueryService(conn, new MysqlDialect(), (info) => seen.push(info));
    await svc.query('DELETE FROM users WHERE id = 1');
    expect(seen[0].affectedRows).toBe(7);
  });

  it('失败也上报，并带上错误信息', async () => {
    const conn = new FakeConnection();
    conn.query = (_sql: string, values?: any, callback?: any) => {
      const cb = callback || values;
      cb(new Error('syntax error'));
    };
    const seen: ExecutedStatement[] = [];
    const svc = new QueryService(conn, new MysqlDialect(), (info) => seen.push(info));
    await expect(svc.query('BAD SQL')).rejects.toThrowError('syntax error');
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBe('syntax error');
  });

  it('skipHistory 跳过上报（含密码语句与批量循环靠它保护）', async () => {
    const conn = new FakeConnection();
    const seen: ExecutedStatement[] = [];
    const svc = new QueryService(conn, new MysqlDialect(), (info) => seen.push(info));
    await svc.query("CREATE USER 'a'@'%' IDENTIFIED BY 'secret'", undefined, { skipHistory: true });
    expect(seen).toEqual([]);
  });

  it('元数据读取（queryAll）与分页读取（queryPage）不上报', async () => {
    const conn = new FakeConnection();
    const seen: ExecutedStatement[] = [];
    const svc = new QueryService(conn, new MysqlDialect(), (info) => seen.push(info));
    await svc.queryAll('SHOW TABLES');
    await svc.queryPage('SELECT * FROM users', 0, 10);
    expect(seen).toEqual([]);
  });

  /**
   * 观察者是旁路设施。它抛异常绝不能冒泡到调用方 ——
   * 否则一条已经成功的 DDL 会被报成失败，而库里其实已经改完了。
   */
  it('观察者抛异常不影响查询结果', async () => {
    const conn = new FakeConnection();
    const svc = new QueryService(conn, new MysqlDialect(), () => { throw new Error('history broken'); });
    const res = await svc.query('SELECT 1');
    expect(res.rows).toEqual([{ id: 1 }]);
  });
});

describe('QueryService 事务状态跟踪（连接池淘汰保护）', () => {
  it('BEGIN 成功后 inTransaction=true，COMMIT/ROLLBACK 后复位', async () => {
    const svc = new QueryService(new FakeConnection(), new MysqlDialect());
    expect(svc.inTransaction).toBe(false);
    await svc.query('BEGIN');
    expect(svc.inTransaction).toBe(true);
    await svc.query('COMMIT');
    expect(svc.inTransaction).toBe(false);
    await svc.query('START TRANSACTION');
    expect(svc.inTransaction).toBe(true);
    await svc.query('ROLLBACK');
    expect(svc.inTransaction).toBe(false);
  });

  it('BEGIN 失败不残留事务状态（否则该会话永不淘汰）', async () => {
    const conn = new FakeConnection();
    conn.error = new Error('already in a transaction');
    const svc = new QueryService(conn, new MysqlDialect());
    await expect(svc.query('BEGIN')).rejects.toThrow(/already in a transaction/);
    expect(svc.inTransaction).toBe(false);
  });

  it('BEGIN 超时也复位事务状态', async () => {
    const conn = new FakeConnection();
    conn.hang = true;
    // 第 4 个构造参数为会话级超时（ms）。
    const svc = new QueryService(conn, new MysqlDialect(), undefined, 20);
    await expect(svc.query('BEGIN')).rejects.toThrow(/timeout/i);
    expect(svc.inTransaction).toBe(false);
  });

  it('BEGIN 被取消也复位事务状态', async () => {
    const conn = new FakeConnection();
    conn.hang = true;
    const svc = new QueryService(conn, new MysqlDialect());
    const p = svc.query('BEGIN');
    await Promise.resolve();
    expect(svc.inTransaction).toBe(true);
    svc.cancel();
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(svc.inTransaction).toBe(false);
  });
});