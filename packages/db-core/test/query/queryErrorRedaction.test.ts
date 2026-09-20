import { describe, expect, it } from 'vitest';
import { QueryService, QueryError } from '../../src/query/queryService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { IConnection } from '../../src/connection/connection';

/**
 * 错误路径上的密码泄漏。
 *
 * `CREATE USER ... IDENTIFIED BY '<明文>'` 这类语句已经带 `skipHistory`，
 * 不会进查询历史。但**失败**时还有两条泄漏路径，此前都没有堵：
 *
 *  1. `QueryError.sql` 原样带着整条语句。目前没有消费者，但错误对象会被
 *     `showErrorMessage`、日志、`JSON.stringify` 碰到 —— 一个只差一步的炸弹。
 *  2. 驱动的 `err.message` 本身就会回显语句片段。MySQL 的语法错误是
 *     `... check the manual ... near 'IDENTIFIED BY 'p@ss''` —— 密码里带个
 *     引号就够触发。这条 message 会被 post 到 webview 显示。
 *
 * 脱敏必须发生在 db-core 里：上层有十几个 catch 点，靠每一处自己记得脱敏
 * 是不可能维持的。
 */

class StubConnection extends IConnection {
  constructor(private readonly err: Error | null, private readonly rows: any[] = []) {
    super({ host: 'h', port: 3306, user: 'u' });
  }
  query(_sql: any, values?: any, callback?: any): void {
    const cb = typeof values === 'function' ? values : callback;
    setImmediate(() => (this.err ? cb(this.err) : cb(null, this.rows, [])));
  }
  connect(cb: (e: any) => void): void { cb(null); }
  beginTransaction(cb: (e: any) => void): void { cb(null); }
  rollback(): void {}
  commit(): void {}
  end(): void {}
  isAlive(): boolean { return true; }
}

const svc = (err: Error | null, observer?: any) =>
  new QueryService(new StubConnection(err), new MysqlDialect(), observer);

const SECRET = 'Tr0ub4dor&3';

describe('QueryError 脱敏', () => {
  const cases: Array<[string, string]> = [
    ['MySQL CREATE USER', `CREATE USER 'bob'@'%' IDENTIFIED BY '${SECRET}'`],
    ['MySQL ALTER USER', `ALTER USER 'bob'@'%' IDENTIFIED BY '${SECRET}'`],
    ['MySQL IDENTIFIED WITH', `CREATE USER 'bob'@'%' IDENTIFIED WITH mysql_native_password BY '${SECRET}'`],
    ['PG CREATE ROLE', `CREATE ROLE "bob" WITH LOGIN PASSWORD '${SECRET}'`],
    ['PG ALTER ROLE', `ALTER ROLE "bob" WITH PASSWORD '${SECRET}'`],
    ['PG ENCRYPTED', `CREATE ROLE "bob" WITH ENCRYPTED PASSWORD '${SECRET}'`],
    ['双引号字面量', `ALTER USER "bob" IDENTIFIED BY "${SECRET}"`],
    ['大小写混排', `create user 'bob'@'%' identified by '${SECRET}'`],
  ];

  for (const [label, sql] of cases) {
    it(`${label}：QueryError.sql 不含明文密码`, async () => {
      const s = svc(new Error('driver failed'));
      const err = await s.query(sql).catch((e) => e as QueryError);
      expect(err).toBeInstanceOf(QueryError);
      expect(err.sql).not.toContain(SECRET);
      // 语句的其余部分要保留，否则错误信息失去排查价值
      expect(err.sql?.toLowerCase()).toContain('bob');
    });
  }

  it('MySQL SET PASSWORD =：`=` 形式不再漏网', async () => {
    const s = svc(new Error('driver failed'));
    const err = await s.query(`SET PASSWORD = '${SECRET}'`).catch((e) => e as QueryError);
    expect(err).toBeInstanceOf(QueryError);
    expect(err.sql).not.toContain(SECRET);
    expect(err.sql).toContain("PASSWORD = '***'");
  });

  it('驱动 message 里回显的密码也被脱敏', async () => {
    const s = svc(new Error(
      `You have an error in your SQL syntax near 'IDENTIFIED BY '${SECRET}'' at line 1`,
    ));
    const err = await s.query(`CREATE USER 'bob'@'%' IDENTIFIED BY '${SECRET}'`).catch((e) => e as QueryError);
    expect(err.message).not.toContain(SECRET);
    // 仍要能看出是语法错误
    expect(err.message).toMatch(/SQL syntax/);
  });

  it('观察者收到的 sql 与 error 都已脱敏', async () => {
    const seen: any[] = [];
    const s = svc(new Error(`bad password '${SECRET}'`), (info: any) => seen.push(info));
    await s.query(`ALTER USER 'bob'@'%' IDENTIFIED BY '${SECRET}'`).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
  });

  it('成功路径的观察者记录同样脱敏', async () => {
    const seen: any[] = [];
    const s = svc(null, (info: any) => seen.push(info));
    await s.query(`CREATE USER 'bob'@'%' IDENTIFIED BY '${SECRET}'`);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  /**
   * 脱敏不能碰普通语句 —— 报错里的 SQL 是主要的排查线索，误伤等于把
   * 有用信息也一起抹掉。
   */
  it('普通语句原样保留', async () => {
    const sql = "SELECT * FROM users WHERE note = 'my password is secret'";
    const s = svc(new Error('nope'));
    const err = await s.query(sql).catch((e) => e as QueryError);
    // 这里没有 IDENTIFIED BY / PASSWORD <字面量> 的结构，不该被改
    expect(err.sql).toBe(sql);
  });

  it('含 PASSWORD 但不是赋值的语句不被误伤', async () => {
    const sql = 'SELECT PASSWORD FROM legacy_users';
    const s = svc(new Error('nope'));
    const err = await s.query(sql).catch((e) => e as QueryError);
    expect(err.sql).toBe(sql);
  });

  it('一条语句里多个密码字面量全部脱敏', async () => {
    const sql = `CREATE USER 'a'@'%' IDENTIFIED BY '${SECRET}'; ALTER USER 'b'@'%' IDENTIFIED BY 'second-${SECRET}'`;
    const s = svc(new Error('x'));
    const err = await s.query(sql).catch((e) => e as QueryError);
    expect(err.sql).not.toContain(SECRET);
    expect((err.sql!.match(/\*\*\*/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('密码里含转义引号也能完整脱敏', async () => {
    const sql = `CREATE USER 'bob'@'%' IDENTIFIED BY 'has''quote'`;
    const s = svc(new Error('x'));
    const err = await s.query(sql).catch((e) => e as QueryError);
    expect(err.sql).not.toContain('quote');
  });

  it('取消与超时的 QueryError 也脱敏', async () => {
    const sql = `CREATE USER 'bob'@'%' IDENTIFIED BY '${SECRET}'`;
    // 永不回调的连接，触发超时路径
    class Hang extends StubConnection {
      query(): void { /* 永不回调 */ }
    }
    const old = QueryService.queryTimeout;
    QueryService.queryTimeout = 10;
    try {
      const s = new QueryService(new Hang(null), new MysqlDialect());
      const err = await s.query(sql).catch((e) => e as QueryError);
      expect(err.sql).not.toContain(SECRET);
      expect(err.message).toMatch(/timeout/i);
    } finally {
      QueryService.queryTimeout = old;
    }
  });
});
