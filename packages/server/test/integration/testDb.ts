/**
 * 真库集成测试的共享门禁。
 *
 * ## 为什么需要它
 *
 * 每个 integration 测试文件都从 `MYSQL_TEST_URL` 取连接目标、从
 * `MYSQL_TEST_DB` 取库名（默认 `dbclient_verify`），然后在那个库上
 * **建表、加索引、全表 DELETE、增删 users**。而 `.env` 里同时存在
 * `MYSQL_DATABASE`（生产库）——两个变量只差几个字符，同一个 shell 里
 * `set -a; . ./.env` 之后它们都在环境里。
 *
 * 一次变量写错、一次复制粘贴漏掉 `export MYSQL_TEST_DB`，测试就会把 DDL 和
 * 全表 DELETE 打到生产库上。那不是"测试失败"，是数据事故 —— 而且发生时
 * 测试全绿，没有任何人会注意到。
 *
 * 所以：解析目标库名时**硬性拒绝**生产库名。宁可测试起不来。
 */

/** 从 mysql:// URL 取连接参数。密码需百分号编码。 */
export function parseMysqlUrl(url: string): {
  host: string; port: number; user: string; password: string;
} {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`bad MYSQL_TEST_URL: ${url}`);
  const [, user, encPwd, host, port] = m;
  return {
    host,
    port: port ? Number(port) : 3306,
    user: decodeURIComponent(user),
    password: decodeURIComponent(encPwd),
  };
}

/**
 * 测试库名。默认 `dbclient_verify`。
 *
 * 三道拒绝：
 *  1. 与 `MYSQL_DATABASE`（生产库）同名 —— 最容易发生的误配。
 *  2. 名字里不含 `verify` / `test` —— 约定测试库必须自带标识，
 *     这样即使有人换了库名也不会误指到一个真实业务库。
 *  3. 空值。
 *
 * 抛错而不是回落到默认值：静默回落会让"我以为在测 A 其实在测 B"成为可能，
 * 而这类错误只在造成损失之后才被发现。
 */
export function resolveTestDb(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.MYSQL_TEST_DB || 'dbclient_verify').trim();
  if (!name) throw new Error('MYSQL_TEST_DB is empty');

  const prod = (env.MYSQL_DATABASE || '').trim();
  if (prod && name.toLowerCase() === prod.toLowerCase()) {
    throw new Error(
      `refusing to run integration tests against MYSQL_DATABASE ("${prod}"): `
      + 'these tests create tables, add indexes and run full-table DELETEs. '
      + 'Set MYSQL_TEST_DB to a dedicated verification database.',
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
