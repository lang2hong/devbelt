import { randomUUID } from 'crypto';
import { verifyPassword } from './password.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { User } from '../../../domain/entities.js';
import { CONSOLE_SCOPES } from '../../../domain/enums.js';
import { RateLimitedError, UnauthorizedError, ValidationError } from '../../../domain/errors.js';
import type { IUserRepo, IDeviceRepo, IRefreshTokenRepo } from '../../../repository/interfaces.js';
import type { TxRunner, Queryable } from '../../../repository/mysql/db.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import { SessionRotationService, type SessionPolicy } from './sessionRotation.js';

/** Web Console 设备槽位（§4.1：每用户最多一个 active web 设备，不计入 maxDevices）。 */
const WEB_PLATFORM = 'web';

/** 控制台会话的轮换策略：aud=console；只允许 web 设备；登出撤销整个 family。 */
const CONSOLE_SESSION_POLICY: SessionPolicy = {
  audience: 'console',
  scope: CONSOLE_SCOPES,
  allowDevice: (bound) => bound.devicePlatform === WEB_PLATFORM,
  reuseAuditEvent: 'console.auth.refresh.reuse',
  logoutScope: 'family',
};

// 登录限流阈值（与 authService 完全一致，共享同一批桶 §4.2）。
const LOGIN_WINDOW_S = 15 * 60;
const LOGIN_MAX = 5;
const LOGIN_ABUSE_MAX = 20;

export interface ConsoleLoginResult {
  accessToken: string;
  refreshToken: string;
  familyId: string;
  user: { userId: string; email: string; displayName?: string };
}

/**
 * 浏览器控制台认证服务（aud=console）。与扩展 authService 分离：web 单设备槽位 +
 * 签发 aud=console / CONSOLE_SCOPES 的 access token。register 复用 authService.register。
 */
export class ConsoleAuthService {
  private readonly rotation: SessionRotationService;

  constructor(
    private readonly userRepo: IUserRepo,
    private readonly deviceRepo: IDeviceRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly tokenService: TokenService,
    private readonly rateLimiter: RateLimitService,
    private readonly runner: TxRunner,
    auditWriter?: AuditWriter,
  ) {
    this.rotation = new SessionRotationService({
      userRepo,
      deviceRepo,
      refreshTokenRepo,
      tokenService,
      runner,
      auditWriter,
    });
  }

  async login(emailRaw: string, password: string, deviceKey: string, ip?: string): Promise<ConsoleLoginResult> {
    const email = normalizeEmail(emailRaw);
    if (!deviceKey) throw new ValidationError('deviceKey is required');

    await this.rateLimiter.assertUnder(`login:email:${email}`, LOGIN_WINDOW_S, LOGIN_ABUSE_MAX);
    await this.rateLimiter.assertUnder(`login:ip:${ip ?? 'unknown'}`, LOGIN_WINDOW_S, LOGIN_ABUSE_MAX);

    const found = await this.userRepo.findByEmail(email);
    if (!found) {
      if (await this.countLoginFailure(email, ip)) throw new RateLimitedError(LOGIN_WINDOW_S);
      throw new UnauthorizedError();
    }
    const userId = found.id;

    const passwordOk = await verifyPassword(password, found.passwordHash);
    const verifiedAgainstHash = found.passwordHash;

    const outcome = await this.runner(async (tx): Promise<
      { ok: false } | { ok: true; accessToken: string; refreshToken: string; familyId: string; user: User }
    > => {
      const user = await this.userRepo.lockById(tx, userId);
      if (!user || user.status !== 'active' || !user.emailVerifiedTime) return { ok: false };
      if (!passwordOk) return { ok: false };
      if (user.passwordHash !== verifiedAgainstHash) return { ok: false };

      const deviceId = await this.upsertWebDevice(tx, user.id, deviceKey);
      const { token, hash, expiresAt } = this.tokenService.generateRefreshToken();
      const familyId = randomUUID();
      await this.refreshTokenRepo.create(tx, {
        userId: user.id,
        deviceId,
        tokenHash: hash,
        familyId,
        expiresTime: expiresAt,
      });
      const accessToken = await this.tokenService.signAccessToken({
        userId: user.id,
        aud: 'console',
        scope: [...CONSOLE_SCOPES],
        sessionId: familyId,
        deviceId,
        sessionVersion: user.sessionVersion,
      });
      return { ok: true, accessToken, refreshToken: token, familyId, user };
    });

    if (!outcome.ok) {
      if (await this.countLoginFailure(email, ip)) throw new RateLimitedError(LOGIN_WINDOW_S);
      throw new UnauthorizedError();
    }

    await this.userRepo.updateLastLogin(userId, new Date());
    return {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
      familyId: outcome.familyId,
      user: sanitizeUser(outcome.user),
    };
  }

  /** 刷新：共享轮换服务（aud=console，只允许 web 设备上的 family）。 */
  async refresh(refreshTokenStr: string): Promise<{ accessToken: string; refreshToken: string }> {
    return this.rotation.refresh(refreshTokenStr, CONSOLE_SESSION_POLICY);
  }

  /** 登出：撤销当前 refresh token 所属整族（§4.2「撤销当前 family」）。 */
  async logout(refreshTokenStr: string | undefined): Promise<{ ok: true }> {
    return this.rotation.logout(refreshTokenStr, CONSOLE_SESSION_POLICY);
  }

  /** 由 refresh token 反查 sessionId（familyId），供 CSRF 会话绑定校验。 */
  async sessionIdOf(refreshTokenStr: string): Promise<string | undefined> {
    const tokenHash = this.tokenService.hashToken(refreshTokenStr);
    const rt = await this.refreshTokenRepo.findByHash(tokenHash);
    // 已撤销/过期的 refresh token 不得再换取会话绑定 CSRF token（fail-closed）。
    if (!rt || rt.revokedTime || rt.expiresTime <= new Date()) return undefined;
    return rt.familyId;
  }

  /**
   * Web 单设备槽位（§4.1）：web 登录按 (userId, platform='web') upsert，不计入
   * maxDevices；新 deviceKey 认领槽位时，事务内撤销旧 web 设备的 refresh family。
   */
  private async upsertWebDevice(exec: Queryable, userId: number, deviceKey: string): Promise<number> {
    const existing = await this.deviceRepo.findActiveByUserAndPlatform(exec, userId, WEB_PLATFORM);
    if (existing && existing.deviceKey !== deviceKey) {
      await this.refreshTokenRepo.revokeByDevice(exec, existing.id, new Date());
      await this.deviceRepo.revoke(exec, existing.id, new Date());
    }
    const saved = await this.deviceRepo.upsert(exec, {
      userId,
      deviceKey,
      devicePlatform: WEB_PLATFORM,
      deviceName: 'Web Console',
      clientVersion: '',
      status: 'active',
      lastUsedTime: new Date(),
    });
    return saved.id;
  }

  private async countLoginFailure(email: string, ip?: string): Promise<boolean> {
    const viaEmail = await this.rateLimiter.hitExceeded(`login:email:${email}`, LOGIN_WINDOW_S, LOGIN_MAX);
    const viaIp = await this.rateLimiter.hitExceeded(`login:ip:${ip ?? 'unknown'}`, LOGIN_WINDOW_S, LOGIN_MAX);
    return viaEmail || viaIp;
  }
}

function normalizeEmail(emailRaw: string): string {
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
  if (!email || email.length > 255 || !email.includes('@')) {
    throw new ValidationError('invalid email');
  }
  return email;
}

function sanitizeUser(user: User): { userId: string; email: string; displayName?: string } {
  return { userId: String(user.id), email: user.email, displayName: user.displayName };
}