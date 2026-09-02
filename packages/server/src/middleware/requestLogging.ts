/**
 * 请求日志脱敏。
 *
 * 邮箱验证 token 与组织邀请 token 出现在 URL path 中
 * （`/api/auth/email-verifications/:token/confirm`、
 *  `/api/organization-invitations/:token/accept`），
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
  /(\/api\/organization-invitations\/)[^/?#]+/,
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
 * Fastify logger 选项：沿用 pino 默认级别，仅替换 req 序列化器。
 *
 * 字段刻意保持最小：method / 脱敏 URL / 客户端地址。不记录 header 与 body，
 * 避免 Authorization、refresh token 与请求正文进入日志（实施规格 §8）。
 */
export function buildLoggerOptions(): {
  // pino 的 SerializerFn 形参是 any；这里保持同构以便直接作为 Fastify logger 选项传入。
  serializers: { [key: string]: (value: any) => unknown };
} {
  return {
    serializers: {
      req: (req: FastifyRequest) => ({
        method: req.method,
        url: redactUrl(req.url),
        remoteAddress: req.ip,
      }),
    },
  };
}
