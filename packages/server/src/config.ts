/**
 * 解析 `TRUST_PROXY`。
 *
 * Fastify 的 `trustProxy` 决定 `req.ip` 从哪里取，而 `req.ip` 是限流的分桶键
 * 和 `devices.ip` 的来源。实测四种取值在「nginx 覆写 XFF」与「nginx 追加 XFF
 * 且客户端伪造」两种情形下的行为：
 *
 * | 取值        | nginx 覆写   | nginx 追加 + 客户端伪造 1.2.3.4 |
 * |-------------|--------------|--------------------------------|
 * | false       | 127.0.0.1    | 127.0.0.1                      |
 * | true        | 203.0.113.9  | **1.2.3.4（可伪造！）**         |
 * | 1           | 203.0.113.9  | 203.0.113.9                    |
 * | '127.0.0.1' | 203.0.113.9  | 203.0.113.9                    |
 *
 * `true` 取 XFF 最左段，那一段完全由客户端控制 —— 攻击者每个请求换一个
 * 伪造 IP 就能绕开所有按 IP 的限流。跳数 `1` 从右往左数，恒等于 nginx
 * 自己写的那一段，两种 nginx 写法都安全。因此这里**显式拒绝 `true`**。
 *
 * 默认 `1`：假定部署在反向代理之后。若 server 被直连暴露，必须设
 * `TRUST_PROXY=false`，否则任何客户端都能通过 XFF 头伪造自己的 IP。
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === '') return 1;
  const v = raw.trim();
  if (v === 'false' || v === '0') return false;
  if (v === 'true') {
    throw new Error(
      'TRUST_PROXY=true is refused: it reads the leftmost X-Forwarded-For entry, ' +
        'which the client fully controls, making per-IP rate limiting bypassable. ' +
        'Use a hop count (TRUST_PROXY=1) or the proxy address (TRUST_PROXY=127.0.0.1) instead.',
    );
  }
  // 纯数字 → 跳数；其余按字符串透传（支持 '127.0.0.1'、CIDR、逗号分隔列表）
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * 服务端配置：从环境变量读取，提供默认值。
 */
export const config = {
  /** 服务端口 */
  port: Number(process.env.PORT || 3000),
  /** JWT 签名密钥（生产必须通过环境变量注入） */
  jwtSecret: (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set in production');
      }
      return 'dev-secret-change-me';
    }
    return secret;
  })(),
  /** Access token 过期时间（短期） */
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  /** Refresh token 过期时间（长期，可撤销） */
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  /** MySQL 连接配置 */
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'dbclient',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'db_client',
  },
  /** 代理信任层级，决定 req.ip 的取值来源。见 parseTrustProxy 的说明 */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /**
   * 限流总闸。
   *
   * 存在的意义是「逃生通道」：阈值配错把所有人（含管理员）锁在门外时，
   * 后台本身也进不去，改不了 DB 里的规则。这个开关不依赖 DB 和后台，
   * 改环境变量重启即可全面放行。
   */
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED !== 'false',
};

export { parseTrustProxy };