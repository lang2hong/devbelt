import { describe, expect, it } from 'vitest';
import { createPool, createConnection } from 'mysql2/promise';

/**
 * 真实 MySQL 上的只读机制验证（不写任何数据）。
 *
 * 这些断言固定的行为：
 * 1. `@fastify/mysql` 默认走 `mysql.createPool`，池中每条连接各自握手；
 * 2. 若连接不带 `database`，池中连接 `DATABASE()` 为 null，访问表报
 *    `ER_NO_DB_ERROR` —— 这是旧「注册后 USE db」方案的缺陷形态
 *    （顺序请求因连接复用偶尔能用，并发必现）。
 * 3. 连接带 `database` 后，每条连接都有默认库，并发不再报错。
 *
 * mysql2 对 `createPool({ connectionString })` 会忽略该选项（视为无效配置），
 * 因此这里用字段形式传参；app.ts 的 `authString()` 走 URL + `encodeURIComponent`，
 * 是另一条路径。本测试直接观测池行为，不写任何数据。
 *
 * 门禁：MYSQL_TEST_URL（形如 mysql://user:pass@host:port，密码须百分号编码）
 * 指向一个**独立测试库**（如 dbclient_verify）。未设置时整体跳过，
 * 保证 `pnpm test` 在无库机器上照常通过。
 */
const URL = process.env.MYSQL_TEST_URL;

function parseHostFields(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url || '');
  if (!m) throw new Error(`无法解析 MYSQL_TEST_URL: ${url}`);
  const [, user, encPwd, host, port] = m;
  return {
    host,
    port: port ? Number(port) : 3306,
    user: decodeURIComponent(user),
    password: decodeURIComponent(encPwd),
  };
}

describe.skipIf(!URL)('MySQL pool default-database mechanism (read-only)', () => {
  it('连接带 database：所有并发连接都有默认库', async () => {
    const { host, port, user, password } = parseHostFields(URL!);
    const pool = createPool({ host, port, user, password, database: 'information_schema', waitForConnections: true, connectionLimit: 8, maxIdle: 8 });
    const res = await Promise.all(
      Array.from({ length: 8 }, () => pool.query('SELECT DATABASE() d').then((r: any) => r[0][0].d)),
    );
    expect(res).toHaveLength(8);
    expect(res.every((d) => d === 'information_schema')).toBe(true);
    await pool.end();
  });

  it('不带 database：并发连接 DATABASE() 恒为 null（旧方案缺陷形态）', async () => {
    const { host, port, user, password } = parseHostFields(URL!);
    const pool = createPool({ host, port, user, password, waitForConnections: true, connectionLimit: 8, maxIdle: 8 });
    const res = await Promise.all(
      Array.from({ length: 8 }, () => pool.query('SELECT DATABASE() d').then((r: any) => r[0][0].d)),
    );
    expect(res).toHaveLength(8);
    expect(res.every((d) => d === null)).toBe(true);
    await pool.end();
  });

  it('不带 database：访问表报 ER_NO_DB_ERROR', async () => {
    // information_schema.TABLES 无需默认库即可访问，必须选依赖默认库的普通表。
    // 这里用一个不存在的表名触发「先判断默认库」的错误路径——旧方案正是登录后
    // 无默认库时对业务表任意查询都会炸。
    const { host, port, user, password } = parseHostFields(URL!);
    const pool = createPool({ host, port, user, password, waitForConnections: true, connectionLimit: 8, maxIdle: 8 });
    await expect(pool.query('SELECT * FROM some_missing_table LIMIT 1')).rejects
      .toMatchObject({ code: 'ER_NO_DB_ERROR' });
    await pool.end();
  });

  it('临时连接可用（供 ensureDatabase 之类 bootstrap 使用）', async () => {
    const { host, port, user, password } = parseHostFields(URL!);
    const conn = await createConnection({ host, port, user, password });
    const [r]: any = await conn.query('SELECT 1 AS ok');
    expect(r[0].ok).toBe(1);
    await conn.end();
  });
}, 30_000);