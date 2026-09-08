import { randomBytes, randomUUID, createHash } from 'crypto';
import type { KeyObject } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { UnauthorizedError } from '../domain/errors.js';
import type { SigningKeys } from './signingKeys.js';
import type { TokenAudience } from '../domain/enums.js';

export type { SigningKeys };

/**
 * Access token 载荷（签发后经 Ed25519 签名，客户端不可读改）。
 * - `sub`：用户 id（十进制字符串）
 * - `aud`：audience（extension / console，§4.1）
 * - `scope`：作用域（粗粒度，见 enums.EXTENSION_SCOPES / CONSOLE_SCOPES）
 * - `sessionId`：refresh family id（会话吊销判定的载体）
 * - `deviceId`：签发设备 id（设备吊销立即失效）
 * - `sessionVersion`：签发时 users.session_version 快照（改密/禁用使旧 token 失效）
 * - `jti`：随机 token ID；`iat` / `exp` 由 jose 自动填；header `kid` 选签名密钥（轮换支持）
 */
export interface AccessTokenPayload {
  sub: string;
  jti: string;
  aud: TokenAudience;
  scope: string[];
  sessionId?: string;
  deviceId?: number;
  sessionVersion?: number;
  iat?: number;
  exp?: number;
}

export interface SignAccessTokenInput {
  userId: number;
  aud: TokenAudience;
  scope: string[];
  sessionId?: string;
  deviceId?: number;
  sessionVersion?: number;
}

/**
 * Token 服务：Ed25519 access token + 随机 refresh token。
 *
 * - access token：Ed25519 JWT，15 分钟，Authorization: Bearer 传输，绝不写 URL/日志。
 * - refresh token：>=256 bits 熵（32 bytes），DB 只存 SHA-256 hash。
 */
export class TokenService {
  constructor(
    private readonly keys: SigningKeys,
    private readonly accessExpiresIn: string,
    private readonly refreshExpiresMs: number,
  ) {}

  /** 签发带 audience/scope/session 声明的 Ed25519 access token。 */
  async signAccessToken(input: SignAccessTokenInput): Promise<string> {
    const jti = randomUUID();
    const payload: Record<string, unknown> = {
      sub: String(input.userId),
      jti,
      aud: input.aud,
      scope: input.scope,
    };
    if (input.sessionId !== undefined) payload.sessionId = input.sessionId;
    if (input.deviceId !== undefined) payload.deviceId = input.deviceId;
    if (input.sessionVersion !== undefined) payload.sessionVersion = input.sessionVersion;

    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keys.kid })
      .setIssuedAt()
      .setExpirationTime(this.accessExpiresIn)
      .sign(this.keys.privateKey);
  }

  /** 验证 access token（按 header kid 选公钥），失败抛 UnauthorizedError。 */
  async verifyAccessToken<T = AccessTokenPayload>(token: string): Promise<T> {
    const { payload } = await jwtVerify(token, this.resolveKey, { algorithms: ['EdDSA'] });
    return payload as T;
  }

  /** 生成 refresh token：返回明文 + hash + 过期时间。 */
  generateRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const hash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + this.refreshExpiresMs);
    return { token, hash, expiresAt };
  }

  /** SHA-256 hash（refresh token / 邮箱验证 token 共用的存储形式）。 */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 按 header 的 kid 从公钥集选择验证密钥；kid 不存在视为验证失败。 */
  private readonly resolveKey = async (protectedHeader: { kid?: string }): Promise<KeyObject> => {
    const kid = protectedHeader?.kid;
    const key = kid ? this.keys.publicKeys.get(kid) : undefined;
    if (!key) throw new UnauthorizedError('unknown signing key');
    return key;
  };
}
