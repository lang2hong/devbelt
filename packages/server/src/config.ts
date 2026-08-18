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

/** 非生产环境缺 JWT_SECRET 时的回落值。公开在仓库里，生产一律拒绝。 */
const DEV_JWT_SECRET = 'dev-secret-change-me';

/**
 * 已知弱密钥黑名单（小写比对）。
 *
 * 这些字符串都公开可见 —— 有的写在 docker-compose.yml 里当默认值，有的是本文件
 * 的开发回落值。凡是能在仓库或文档里搜到的字符串，都等于没有密钥。
 */
const WEAK_JWT_SECRETS = new Set([
  DEV_JWT_SECRET,
  'change-me-in-prod',
  'change-me',
  'changeme',
  'secret',
  'jwt-secret',
  'your-strong-secret-here', // .env.example 的占位值
  'test-secret',
  'test-jwt-secret',
]);

/** 生产环境要求的最小长度。低于此值的密钥可离线爆破。 */
const MIN_JWT_SECRET_LEN = 32;

/**
 * 解析并校验 JWT 签名密钥。
 *
 * 这个密钥是整套认证的根：拿到它就能自签任意 access token（含 role=admin）。
 * `requireAuth` 的会话校验挡不住自签 token —— `refresh_tokens.id` 是自增整数，
 * 对目标用户遍历 `sid=1..N` 即可凑出一条过校验的 token。
 *
 * 原实现只判「生产环境下密钥是否存在」。两条路径让这道检查失效：
 *
 *  1. `docker-compose.yml` 写着 `JWT_SECRET: ${JWT_SECRET:-change-me-in-prod}`。
 *     Dockerfile 设了 `NODE_ENV=production`，本以为「生产必填」能兜住，但 compose
 *     自己给了默认值 —— `process.env.JWT_SECRET` 恒非空，必填检查被自己的默认值
 *     绕过，服务以仓库里公开可见的字符串签名，启动日志毫无提示。
 *  2. 裸进程（systemd / pm2）不设 `NODE_ENV` 时静默回落到 `DEV_JWT_SECRET`，
 *     同样是公开值。
 *
 * 所以生产环境三样都拒：缺失、已知弱值、长度不足。非生产只告警不抛错 ——
 * 开发机上的弱密钥不该阻断启动，而且抛错会让任何 import 本模块的测试直接挂掉。
 *
 * 抽成纯函数是为了可测：不用改 `process.env` 就能断言各分支。
 */
export function resolveJwtSecret(
  raw: string | undefined,
  nodeEnv: string | undefined,
): string {
  const production = nodeEnv === 'production';
  const secret = raw?.trim();

  if (!secret) {
    if (production) {
      throw new Error(
        'JWT_SECRET must be set in production. Generate one with: openssl rand -base64 48',
      );
    }
    console.warn(
      `[config] JWT_SECRET is not set; falling back to the public development key. ` +
        `Never run this configuration in production.`,
    );
    return DEV_JWT_SECRET;
  }

  // 换密钥的代价必须在错误信息里讲清楚：旧 sha256 密码哈希的盐取自 JWT_SECRET，
  // 轮换之后那批还没登录过（因而还没被就地升级为 scrypt）的用户再也验不过密码。
  const rotationHint =
    'Note: legacy sha256 password hashes use JWT_SECRET as their salt, so rotating it ' +
    'locks out users who have not logged in since the scrypt migration.';

  if (WEAK_JWT_SECRETS.has(secret.toLowerCase())) {
    const msg =
      `JWT_SECRET is a well-known default value and provides no security ` +
      `(anyone can read it from the repository and forge admin tokens). ${rotationHint}`;
    if (production) throw new Error(msg);
    console.warn(`[config] ${msg}`);
    return secret;
  }

  if (secret.length < MIN_JWT_SECRET_LEN) {
    const msg =
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LEN} characters ` +
      `(got ${secret.length}); short keys are brute-forceable offline. ${rotationHint}`;
    if (production) throw new Error(msg);
    console.warn(`[config] ${msg}`);
    return secret;
  }

  return secret;
}

/**
 * 服务端配置：从环境变量读取，提供默认值。
 */
export const config = {
  /** 服务端口 */
  port: Number(process.env.PORT || 3000),
  /** JWT 签名密钥（生产必须通过环境变量注入，且拒绝弱值/短值） */
  jwtSecret: resolveJwtSecret(process.env.JWT_SECRET, process.env.NODE_ENV),
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