import { randomBytes, createHash } from 'crypto';

/**
 * JWT 端口（端口接口，隔离 fastify-jwt 实现）。
 * service 层依赖此接口而非 fastify app，便于测试与替换签名实现。
 */
export interface JwtPort {
  sign(payload: object, options?: { expiresIn?: string | number }): string;
  verify<T = any>(token: string): T;
}

/** 解析时长字符串（如 '30d'、'15m'）为毫秒 */
function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return 30 * 86400 * 1000;
  const n = parseInt(m[1], 10);
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * mult[m[2]];
}

/**
 * Token 服务（Factory 模式）：
 * - access token：JWT 短期（15m），payload 含 sub/role/plan
 * - refresh token：随机 256bit token，仅 hash 存库（明文返回客户端）
 *
 * refresh 轮换：旧 refresh 标记 revoked，签新 refresh；重用检测在 AuthService 层。
 */
export class TokenService {
  private readonly refreshExpiresMs: number;

  constructor(
    private readonly jwt: JwtPort,
    private readonly accessExpiresIn: string,
    refreshExpiresIn: string,
  ) {
    this.refreshExpiresMs = parseDuration(refreshExpiresIn);
  }

  /** 签发 access token（JWT） */
  signAccessToken(sub: number, role: string, plan: string): string {
    return this.jwt.sign({ sub, role, plan }, { expiresIn: this.accessExpiresIn });
  }

  /** 校验 access token，返回 payload */
  verifyAccessToken<T = any>(token: string): T {
    return this.jwt.verify<T>(token);
  }

  /** 生成 refresh token：返回明文 + hash + 过期时间 */
  generateRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + this.refreshExpiresMs);
    return { token, hash, expiresAt };
  }

  /** 计算 refresh token 的 hash（查找/撤销用） */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
