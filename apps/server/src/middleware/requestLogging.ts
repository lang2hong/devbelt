/**
 * 请求日志脱敏。
 *
 * 邮箱验证 token 出现在 URL path 中
 * （`/api/auth/email-verifications/:token/confirm`），
 * 而 Fastify 默认的 req 序列化器会把完整 URL 写进访问日志。
 * 实施规格 §8 要求日志不得包含 token，因此这里统一在写日志前替换掉 token 段，
 * 并抹掉常见的 token 查询参数。
 *
 * 只影响日志输出：路由匹配与 handler 读到的仍是原始 URL。
 */
import type { FastifyRequest } from 'fastify';

const REDACTED = '[redacted]';

/** URL path 中承载 token 的位置：保留前缀分组，替换其后的单个段。 */
const PATH_TOKEN_PATTERNS: readonly RegExp[] = [
  /(\/api\/auth\/email-verifications\/)[^/?#]+/,
];

/** 查询参数名（小写比较）：命中即整体替换值。 */
const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'recoverycode',
]);

/** 对单条 URL 做脱敏；输入非字符串或空串时原样返回。 */
export function redactUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl === '') return rawUrl;

  // fragment 不会发到服务端，日志里直接丢掉，避免误当作 path 处理。
  const hashIndex = rawUrl.indexOf('#');
  const withoutHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);

  const queryIndex = withoutHash.indexOf('?');
  let path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1);

  for (const pattern of PATH_TOKEN_PATTERNS) {
    path = path.replace(pattern, `$1${REDACTED}`);
  }

  if (!query) return path;

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      if (pair === '') return pair;
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      if (!SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return pair;
      return `${key}=${REDACTED}`;
    })
    .join('&');

  return `${path}?${redactedQuery}`;
}

/**
 * 保留字段：mysql2 诊断码 + 堆栈。这是 error 序列化的**白名单**，
 * 白名单之外的任何自有属性一律丢弃 —— pino 默认会拷贝全部可枚举属性，
 * 未来任何依赖新增的 `accessToken`/`apiKey` 等标量都会随之泄露。
 *
 * `stack` 只含代码位置、不含行数据，是排查 500 的主要线索，故保留。
 */
const ERR_KEEP_KEYS: readonly string[] = ['code', 'errno', 'sqlState', 'fatal'];

/**
 * error 序列化器：保留类型/消息/诊断码，剥离一切可能携带行数据的字段。
 *
 * 注意 `message` 仍然保留 —— DomainError 的消息是自己写的、不含密钥；
 * 但 mysql2 的 `message` 常等于 `sqlMessage`，故对带 `code` 的驱动错误
 * 只保留一句固定文本，具体原因靠 `code`/`errno` 判断。
 */
export function serializeError(err: unknown): unknown {
  if (err === null || typeof err !== 'object') return { message: String(err) };

  const e = err as Record<string, unknown> & { name?: string; message?: string };
  const isDriverError = typeof e.code === 'string' && (e.errno !== undefined || e.sqlState !== undefined);

  const out: Record<string, unknown> = {
    type: e.name ?? 'Error',
    // 驱动错误的 message 常与 sqlMessage 同源（可能回显字段值），不透传。
    message: isDriverError ? 'database error (details omitted)' : String(e.message ?? ''),
  };

  for (const k of ERR_KEEP_KEYS) {
    if (e[k] !== undefined) out[k] = e[k];
  }
  if (typeof e.stack === 'string') out.stack = e.stack;

  return out;
}

/**
 * Fastify logger 选项：沿用 pino 默认级别，替换 req 与 err 序列化器。
 *
 * req 字段刻意保持最小：method / 脱敏 URL / 客户端地址。不记录 header 与 body，
 * 避免 Authorization、refresh token 与请求正文进入日志（实施规格 §8）。
 * err 走 serializeError，剥离 mysql2 的内联 SQL。
 */
export function buildLoggerOptions(): {
  // pino 的 SerializerFn 形参是 any；这里保持同构以便直接作为 Fastify logger 选项传入。
  serializers: { [key: string]: (value: any) => unknown };
  timestamp: () => string;
} {
  return {
    // 日志时间戳统一为北京时间 `YYYY-MM-DD HH:mm:ss`（与展示层 / 支付宝时间格式一致）。
    timestamp: () => `,"time":"${formatLogTime(new Date())}"`,
    serializers: {
      req: (req: FastifyRequest) => ({
        method: req.method,
        url: redactUrl(req.url),
        remoteAddress: req.ip,
      }),
      err: (err: unknown) => serializeError(err),
    },
  };
}

/** 北京时间 `YYYY-MM-DD HH:mm:ss`（+08:00，不依赖服务器 TZ 配置）。 */
function formatLogTime(now: Date): string {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())} ${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}:${p(sh.getUTCSeconds())}`;
}
