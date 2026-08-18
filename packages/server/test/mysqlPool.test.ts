import { describe, expect, it } from 'vitest';
import { buildMysqlPoolOptions } from '../src/mysqlPool.js';

/**
 * MySQL 连接池参数。
 *
 * 原来是 `app.register(mysql, { connectionString: authString(), promise: true })`。
 * `@fastify/mysql` 的实现是 `mysql.createPool(options.connectionString || options)`
 * —— 传了 connectionString 就**只用这个 URL**，其余选项全部丢弃。URL 里没有
 * query string，于是 mysql2 全部走默认值：
 *
 *  - `connectionLimit: 10`
 *  - `queueLimit: 0` —— 排队队列**无上限**
 *  - 无获取超时（mysql2 的 connectTimeout 只管建连，不管从池里拿连接）
 *  - `timezone: 'local'` —— 见下面时区那组断言
 *
 * 而单请求的串行查询数很高：每个已认证请求固定 2 次（getUser + getSession），
 * `/api/me` 约 8~10 次，`PUT /api/sync` 是 12+N 次。10 个并发就能占满全池，
 * 第 11 个请求进入无上限队列且无超时，一直挂到客户端或反代超时。
 * 生产表现是「偶发全站卡死，MySQL 侧却看不到慢查询」—— 瓶颈在池排队，不在 SQL。
 */
describe('buildMysqlPoolOptions', () => {
  const base = {
    host: 'db.internal',
    port: 3306,
    user: 'dbclient',
    password: 'p@ss:word/with?specials',
    database: 'db_client',
  };

  it('用字段形式传参，不再走 connectionString', () => {
    const o = buildMysqlPoolOptions(base, {});
    // connectionString 一旦存在，@fastify/mysql 会丢掉其余所有选项
    expect(o).not.toHaveProperty('connectionString');
    expect(o.host).toBe('db.internal');
    expect(o.database).toBe('db_client');
  });

  it('密码含特殊字符时原样传递（URL 形式需要百分号编码，字段形式不需要）', () => {
    const o = buildMysqlPoolOptions(base, {});
    expect(o.password).toBe('p@ss:word/with?specials');
  });

  it('排队队列有上限：满了立刻失败胜过无限期挂住', () => {
    const o = buildMysqlPoolOptions(base, {});
    expect(o.queueLimit).toBeGreaterThan(0);
  });

  it('等待连接而不是直接报错（waitForConnections 为真）', () => {
    expect(buildMysqlPoolOptions(base, {}).waitForConnections).toBe(true);
  });

  it('连接数上限显式给出且高于 mysql2 的默认 10', () => {
    expect(buildMysqlPoolOptions(base, {}).connectionLimit).toBeGreaterThan(10);
  });

  it('时区钉死 UTC', () => {
    // mysql2 默认 timezone:'local'，按 Node 进程本地时区格式化 Date。
    // MySQL 对 TIMESTAMP 列按 session time_zone 折算成 UTC 存储，对 DATETIME
    // 列不做任何转换 —— 本库两种类型混用（traffic_stats.bucket_time 是 DATETIME，
    // 其余业务表是 TIMESTAMP）。Node 与 MySQL 时区不一致时，同一个管理页面上
    // 「小时柱状图」与「被限流请求」会错开数小时，而 expires_time / period_end_time
    // 这类判定也整体平移。本机开发时两者同机同区，所以一切正常 —— 这正是难查的地方。
    expect(buildMysqlPoolOptions(base, {}).timezone).toBe('Z');
  });

  it('开启 keepAlive，避免空闲连接被中间设备静默掐断', () => {
    const o = buildMysqlPoolOptions(base, {});
    expect(o.enableKeepAlive).toBe(true);
  });

  it('建连超时有上限，不会无限期握手', () => {
    expect(buildMysqlPoolOptions(base, {}).connectTimeout).toBeGreaterThan(0);
  });

  it('池大小可由环境变量覆盖', () => {
    expect(buildMysqlPoolOptions(base, { MYSQL_POOL_SIZE: '40' }).connectionLimit).toBe(40);
  });

  it('非法的池大小回落到默认值而不是 NaN', () => {
    const o = buildMysqlPoolOptions(base, { MYSQL_POOL_SIZE: 'abc' });
    expect(Number.isFinite(o.connectionLimit)).toBe(true);
    expect(o.connectionLimit).toBeGreaterThan(10);
  });

  it('池大小为 0 或负数时同样回落（否则池永远借不出连接）', () => {
    expect(buildMysqlPoolOptions(base, { MYSQL_POOL_SIZE: '0' }).connectionLimit).toBeGreaterThan(10);
    expect(buildMysqlPoolOptions(base, { MYSQL_POOL_SIZE: '-5' }).connectionLimit).toBeGreaterThan(10);
  });

  it('必须带 database：池中每条连接独立握手，靠一次 USE db 盖不住', () => {
    expect(buildMysqlPoolOptions(base, {}).database).toBe('db_client');
  });
});
