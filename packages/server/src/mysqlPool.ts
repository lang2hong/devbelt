/**
 * MySQL 连接池参数构造。
 *
 * 抽成独立模块而不是留在 app.ts 里，是为了能在不起服务、不连库的情况下断言
 * 这些参数 —— 池配置错了不会有任何报错，只会在生产的某个并发高峰突然表现为
 * 「全站卡死但 MySQL 侧看不到慢查询」，事后极难定位。
 */

/** 池大小默认值。高于 mysql2 的默认 10：单请求的串行查询数本身就有 2~12 次。 */
const DEFAULT_POOL_SIZE = 20;

/**
 * 排队上限。
 *
 * mysql2 的默认 `queueLimit: 0` 是**无上限**：池满之后请求无限期排队，且没有
 * 获取超时（`connectTimeout` 只管建连，不管从池里拿）。一次慢查询风暴就会让
 * 队列堆到内存耗尽，而客户端看到的是全部请求挂死。给上限之后，池满时新请求
 * 立刻拿到错误（可映射成 503），失败快于挂死。
 */
const QUEUE_LIMIT = 100;

export interface MysqlCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface MysqlPoolOptions extends MysqlCredentials {
  waitForConnections: boolean;
  connectionLimit: number;
  queueLimit: number;
  connectTimeout: number;
  enableKeepAlive: boolean;
  keepAliveInitialDelay: number;
  timezone: string;
  charset: string;
}

/**
 * 构造池参数。
 *
 * 为什么不能用 `connectionString`：`@fastify/mysql` 的实现是
 * `mysql.createPool(options.connectionString || options)` —— 传了 URL 就只用
 * 这个 URL，其余选项**全部被丢弃**。而 `authString()` 生成的 URL 没有 query
 * string，于是 mysql2 全走默认值：10 连接、队列无上限、无获取超时、
 * `timezone: 'local'`。字段形式还顺带省掉了密码的百分号编码问题。
 *
 * `timezone: 'Z'` 是必需的：mysql2 默认按 Node 进程本地时区格式化 `Date`，
 * 而 v2 统一用 `DATETIME`（UTC）存储。Node 与 MySQL 时区不一致时会整体错开，
 * `expires_time`（会话过期）与 `period_end_time`（订阅到期）的判定也随之平移。
 */
export function buildMysqlPoolOptions(
  creds: MysqlCredentials,
  env: Record<string, string | undefined>,
): MysqlPoolOptions {
  const raw = Number(env.MYSQL_POOL_SIZE);
  // 非法值/0/负数一律回落：连接数为 0 的池永远借不出连接，比配置错误更难查
  const connectionLimit = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POOL_SIZE;

  return {
    ...creds,
    waitForConnections: true,
    connectionLimit,
    queueLimit: QUEUE_LIMIT,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    timezone: 'Z',
    charset: 'utf8mb4_0900_ai_ci',
  };
}
