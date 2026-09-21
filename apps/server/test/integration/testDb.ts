/**
 * 真库集成测试的共享门禁。
 *
 * ## 为什么需要它
 *
 * 每个 integration 测试文件都从 `DEVBELT_DB_TEST_MYSQL_URL` 取连接目标、从
 * `DEVBELT_DB_TEST_MYSQL_DB` 取库名（默认 `devbelt_db_verify`），然后在那个库上
 * **建表、加索引、全表 DELETE、增删 users**。而 `.env` 里同时存在
 * `DEVBELT_DB_MYSQL_DATABASE`（生产库）——两个变量只差几个字符，同一个 shell 里
 * `set -a; . ./.env` 之后它们都在环境里。
 *
 * 一次变量写错、一次复制粘贴漏掉 `export DEVBELT_DB_TEST_MYSQL_DB`，测试就会把 DDL 和
 * 全表 DELETE 打到生产库上。那不是"测试失败"，是数据事故 —— 而且发生时
 * 测试全绿，没有任何人会注意到。
 *
 * 所以：解析目标库名时**硬性拒绝**生产库名。宁可测试起不来。
 */

import mysql from 'mysql2/promise';
import { mysqlTimeZoneInit } from '../../src/repository/mysql/mysqlTimeZoneInit.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

/** 从 mysql:// URL 取连接参数。密码需百分号编码。 */
export function parseMysqlUrl(url: string): {
  host: string; port: number; user: string; password: string;
} {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`bad DEVBELT_DB_TEST_MYSQL_URL: ${url}`);
  const [, user, encPwd, host, port] = m;
  return {
    host,
    port: port ? Number(port) : 3306,
    user: decodeURIComponent(user),
    password: decodeURIComponent(encPwd),
  };
}

/**
 * 测试库名。默认 `devbelt_db_verify`。
 *
 * 三道拒绝：
 *  1. 与 `DEVBELT_DB_MYSQL_DATABASE`（生产库）同名 —— 最容易发生的误配。
 *  2. 名字里不含 `verify` / `test` —— 约定测试库必须自带标识，
 *     这样即使有人换了库名也不会误指到一个真实业务库。
 *  3. 空值。
 *
 * 抛错而不是回落到默认值：静默回落会让"我以为在测 A 其实在测 B"成为可能，
 * 而这类错误只在造成损失之后才被发现。
 */
export function resolveTestDb(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.DEVBELT_DB_TEST_MYSQL_DB || 'devbelt_db_verify').trim();
  if (!name) throw new Error('DEVBELT_DB_TEST_MYSQL_DB is empty');

  const prod = (env.DEVBELT_DB_MYSQL_DATABASE || '').trim();
  if (prod && name.toLowerCase() === prod.toLowerCase()) {
    throw new Error(
      `refusing to run integration tests against DEVBELT_DB_MYSQL_DATABASE ("${prod}"): `
      + 'these tests create tables, add indexes and run full-table DELETEs. '
      + 'Set DEVBELT_DB_TEST_MYSQL_DB to a dedicated verification database.',
    );
  }

  if (!/verify|test/i.test(name)) {
    throw new Error(
      `refusing to run integration tests against "${name}": the database name must contain `
      + '"verify" or "test" so it cannot be mistaken for a real one.',
    );
  }
  return name;
}

/**
 * 集成测试的共享连接池工厂。
 *
 * 必须经此创建，不要直接 `mysql.createPool`。时区正确需要**两层**设置，
 * 少任何一层都会出现难查的偏移（见 mysqlPool.ts 的说明）：
 *
 *  1. `timezone: 'Z'` —— mysql2 客户端侧对 `Date` 的序列化时区。
 *  2. `mysqlTimeZoneInit` —— MySQL **会话**的 `SET time_zone='+00:00'`，
 *     决定服务端 `NOW()` / `CURRENT_TIMESTAMP` 的语义。
 *
 * 此前 12 处测试各自 createPool 只设了第 1 层。在会话时区非 UTC 的实例上
 * （本项目的 RDS 是 +08:00），`expires_time > NOW(3)` 这类**服务端时钟比较**
 * 会整体偏移 8 小时 —— 1 小时有效期的 sync reset token 一创建即被判为过期，
 * 表现为「刚写入就查不到」。生产同样受影响，因此这是实现问题而非测试问题。
 */
export function createTestPool(): mysql.Pool {
  const url = process.env.DEVBELT_DB_TEST_MYSQL_URL;
  if (!url) throw new Error('DEVBELT_DB_TEST_MYSQL_URL is required to create a test pool');
  const { host, port, user, password } = parseMysqlUrl(url);
  const pool = mysql.createPool({
    host, port, user, password,
    database: resolveTestDb(),
    timezone: 'Z',
  });
  mysqlTimeZoneInit(pool as unknown as MysqlDb);
  return pool;
}
