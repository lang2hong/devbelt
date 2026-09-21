/**
 * 真库集成测试的共享门禁。
 *
 * ## 为什么需要它
 *
 * 每个 integration 测试文件都从 `DEVBELT_DB_TEST_MYSQL_URL` 取连接目标、从
 * `DEVBELT_DB_TEST_MYSQL_DB` 取库名（默认 `devbelt_db_verify`），然后在那个库上
 * **建临时表、写数据、执行 KILL QUERY**。而跑这些测试通常要先
 * `set -a; . ../server/.env; set +a` 拿到连接参数 —— 那一步会把
 * `DEVBELT_DB_MYSQL_DATABASE`（生产库）也带进环境，两个变量只差几个字符。
 *
 * 一次变量写错、一次复制粘贴漏掉 `export DEVBELT_DB_TEST_MYSQL_DB`，测试就会把 DDL 和
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
      + 'these tests create and drop tables and kill running queries. '
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
