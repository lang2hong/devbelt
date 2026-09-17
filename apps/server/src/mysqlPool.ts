/**
 * MySQL 连接池参数构造。
 *
 * 抽成独立模块而不是留在 app.ts 里，是为了能在不起服务、不连库的情况下断言
 * 这些参数 —— 池配置错了不会有任何报错，只会在生产的某个并发高峰突然表现为
 * 「全站卡死但 MySQL 侧看不到慢查询」，事后极难定位。
 */
import { readFileSync } from 'fs';

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

export interface MysqlSslOptions {
  /** CA 证书内容（PEM）。用于校验服务端证书链。 */
  ca?: string;
  /**
   * 是否校验服务端证书。默认 true。
   * 置 false 仅用于自签证书的临时排查 —— 此时链路虽加密但**不防中间人**。
   */
  rejectUnauthorized: boolean;
  /** 期望的服务端主机名（证书 CN/SAN 与实际连接地址不一致时使用）。 */
  servername?: string;
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
  /** TLS 配置；未启用时为 undefined（mysql2 视作明文连接）。 */
  ssl?: MysqlSslOptions;
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
    ssl: buildSslOptions(env),
  };
}

/**
 * TLS 选项。
 *
 * 不配置任何 `MYSQL_SSL*` 时返回 undefined，保持明文连接（本地 docker / 回环）。
 * 一旦库在网络另一端（托管 RDS 等），明文链路上会经过：握手阶段的账号密码，
 * 以及 payload 里的 `password_hash`、各类 `token_hash`、E2E `ciphertext/nonce/tag`。
 *
 * 取值：
 * - `MYSQL_SSL=true|1`            启用 TLS（不带 CA 时依赖系统根证书）
 * - `MYSQL_SSL_CA`                CA 证书 PEM 内容；给出即隐含启用
 * - `MYSQL_SSL_CA_FILE`           CA 证书路径；给出即隐含启用
 * - `MYSQL_SSL_REJECT_UNAUTHORIZED=false` 关闭证书校验（**不防 MITM**，仅排查用）
 * - `MYSQL_SSL_SERVERNAME`        证书主机名与连接地址不一致时指定
 */
function buildSslOptions(env: Record<string, string | undefined>): MysqlSslOptions | undefined {
  const flag = (env.MYSQL_SSL ?? '').trim().toLowerCase();
  const caInline = (env.MYSQL_SSL_CA ?? '').trim();
  const caFile = (env.MYSQL_SSL_CA_FILE ?? '').trim();
  const enabled = flag === 'true' || flag === '1' || caInline !== '' || caFile !== '';
  if (!enabled) return undefined;

  let ca: string | undefined = caInline || undefined;
  if (!ca && caFile) {
    // 读失败不静默降级成明文：那会把「以为加密了」变成「其实没加密」。
    ca = readFileSync(caFile, 'utf8');
  }

  const rejectRaw = (env.MYSQL_SSL_REJECT_UNAUTHORIZED ?? '').trim().toLowerCase();
  const rejectUnauthorized = !(rejectRaw === 'false' || rejectRaw === '0');

  const servername = (env.MYSQL_SSL_SERVERNAME ?? '').trim() || undefined;

  return { ca, rejectUnauthorized, servername };
}
