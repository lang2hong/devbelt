import { randomBytes, createHash } from 'crypto';

/**
 * JWT 端口（端口接口，隔离 fastify-jwt 实现）。
 * service 层依赖此接口而非 fastify app，便于测试与替换签名实现。
 */
export interface JwtPort {
  sign(payload: object, options?: { expiresIn?: string | number }): string;
  verify<T = any>(token: string): T;
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

  /**
   * @param refreshExpiresIn refresh token 有效期。可传毫秒数（推荐，由
   *        config.parseTokenTtl 解析并校验过）或 `\d+[smhd]` 字符串。
   *
   *        原实现内部有一个 parseDuration，对非法值**静默回落到 30 天**
   *        （`1y` → 30d，配置写错完全无感）。解析与校验已上移到 config.ts，
   *        非法值在启动时就失败；这里保留字符串分支仅为兼容直接构造的测试。
   */
  constructor(
    private readonly jwt: JwtPort,
    private readonly accessExpiresIn: string,
    refreshExpiresIn: string | number,
  ) {
    if (typeof refreshExpiresIn === 'number') {
      this.refreshExpiresMs = refreshExpiresIn;
    } else {
      const m = /^(\d+)([smhd])$/.exec(refreshExpiresIn);
      if (!m) throw new Error(`invalid refresh token ttl: ${JSON.stringify(refreshExpiresIn)}`);
      const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      this.refreshExpiresMs = Number(m[1]) * mult[m[2]];
    }
  }

  /** 签发 access token（JWT）；sid 为当前 refresh token 主键，用于标记"当前设备" */
  signAccessToken(sub: number, role: string, sid: number): string {
    return this.jwt.sign({ sub, role, sid }, { expiresIn: this.accessExpiresIn });
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
