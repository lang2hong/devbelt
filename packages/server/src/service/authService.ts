import type { IUserRepo, IPlanRepo, ISubscriptionRepo, IRefreshTokenRepo } from '../repository/interfaces.js';
import type { TokenService } from './tokenService.js';
import type { Subscription, User, SessionInfo } from '../domain/entities.js';
import { hashPassword, verifyPassword } from './password.js';
import { InvalidCredentialsError, DeviceLimitError, TokenReuseError, ValidationError } from '../domain/errors.js';

/** 设备信息（登录/刷新时记录到 refresh_tokens） */
export interface DeviceInfo {
  deviceName?: string;
  userAgent?: string;
  ip?: string;
}

/** 脱敏用户（不含 passwordHash） */
export type UserInfo = Omit<User, 'passwordHash'>;

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: UserInfo;
  subscription?: Subscription;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

const TRIAL_DAYS = 14;

/**
 * 认证服务（Facade）：协调 user/subscription/refreshToken repo + TokenService。
 * 职责：注册/登录/刷新/登出/会话管理。
 * 令牌策略：access JWT 短期 + refresh 随机 token（hash 存库）+ 轮换 + 重用检测。
 */
export class AuthService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly planRepo: IPlanRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly tokenService: TokenService,
    private readonly jwtSecret: string,
  ) {}

  /** 注册：建 user(free) + 试用订阅(14d) + 签双 token */
  async register(email: string, password: string, device?: DeviceInfo): Promise<AuthResponse> {
    if (!email || !password) throw new InvalidCredentialsError();
    if (typeof email !== 'string' || !email.includes('@')) throw new ValidationError('invalid email format');
    if (password.length < 8) throw new ValidationError('password must be at least 8 chars');

    const exist = await this.userRepo.findByEmail(email);
    if (exist) throw new InvalidCredentialsError();

    const hash = hashPassword(password);
    const user = await this.userRepo.create(email, hash, 'user', 'free');

    const periodEnd = new Date(Date.now() + TRIAL_DAYS * 86400000);
    const subscription = await this.subRepo.upsert({
      userId: user.id, planCode: 'free', status: 'trialing',
      periodEndTime: periodEnd, trialEndTime: periodEnd, provider: 'manual',
    });

    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
    await this.refreshTokenRepo.create({ userId: user.id, tokenHash: rtHash, ...device, expiresTime: expiresAt });
    const accessToken = this.tokenService.signAccessToken(user.id, user.role, user.planCode);
    await this.userRepo.updateLastLogin(user.id, new Date());

    return { accessToken, refreshToken: token, user: sanitize(user), subscription };
  }

  /** 登录：校验凭据 + 设备数检查 + 签双 token */
  async login(email: string, password: string, device?: DeviceInfo): Promise<AuthResponse> {
    if (!email || !password) throw new InvalidCredentialsError();
    const user = await this.userRepo.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash, this.jwtSecret)) throw new InvalidCredentialsError();
    if (user.status !== 'active') throw new InvalidCredentialsError();

    const plan = await this.planRepo.findByCode(user.planCode);
    const now = new Date();
    if (plan && plan.maxDevices > 0) {
      const count = await this.refreshTokenRepo.countActiveForUser(user.id, now);
      if (count >= plan.maxDevices) throw new DeviceLimitError(plan.maxDevices, count);
    }

    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
    await this.refreshTokenRepo.create({ userId: user.id, tokenHash: rtHash, ...device, expiresTime: expiresAt });
    const accessToken = this.tokenService.signAccessToken(user.id, user.role, user.planCode);
    await this.userRepo.updateLastLogin(user.id, now);

    const subscription = await this.subRepo.findByUserId(user.id);
    return { accessToken, refreshToken: token, user: sanitize(user), subscription };
  }

  /**
   * 刷新：用 refresh token 换新 access + 轮换 refresh。
   * 重用检测：已撤销的 refresh 被使用 → 撤销该用户全部会话（强制全部设备下线）。
   */
  async refresh(refreshTokenStr: string, device?: DeviceInfo): Promise<RefreshResponse> {
    const hash = this.tokenService.hashToken(refreshTokenStr);
    const rt = await this.refreshTokenRepo.findByHash(hash);
    if (!rt) throw new InvalidCredentialsError();
    const now = new Date();

    if (rt.revokedTime) {
      await this.refreshTokenRepo.revokeAllForUser(rt.userId);
      throw new TokenReuseError(rt.id, rt.userId);
    }
    if (rt.expiresTime <= now) throw new InvalidCredentialsError();

    await this.refreshTokenRepo.updateLastUsed(rt.id, now);
    await this.refreshTokenRepo.revoke(rt.id);
    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
    await this.refreshTokenRepo.create({ userId: rt.userId, tokenHash: rtHash, ...device, expiresTime: expiresAt });

    const user = await this.userRepo.findById(rt.userId);
    if (!user) throw new InvalidCredentialsError();
    const accessToken = this.tokenService.signAccessToken(user.id, user.role, user.planCode);
    return { accessToken, refreshToken: token };
  }

  /** 登出：撤销当前 refresh token */
  async logout(refreshTokenStr: string): Promise<void> {
    const hash = this.tokenService.hashToken(refreshTokenStr);
    const rt = await this.refreshTokenRepo.findByHash(hash);
    if (rt && !rt.revokedTime) await this.refreshTokenRepo.revoke(rt.id);
  }

  /** 列出当前用户活跃会话 */
  async listSessions(userId: number): Promise<SessionInfo[]> {
    return this.refreshTokenRepo.listActiveForUser(userId, new Date());
  }

  /** 踢出指定设备会话 */
  async revokeSession(userId: number, sessionId: number): Promise<void> {
    const session = await this.refreshTokenRepo.findById(sessionId);
    if (!session || session.userId !== userId) throw new InvalidCredentialsError();
    await this.refreshTokenRepo.revoke(sessionId);
  }

  /** 修改密码：验旧密码 → 更新 → 撤销全部会话（强制所有设备重新登录） */
  async changePassword(userId: number, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new InvalidCredentialsError();
    if (!verifyPassword(oldPassword, user.passwordHash, this.jwtSecret)) throw new InvalidCredentialsError();
    if (!newPassword || newPassword.length < 8) throw new ValidationError('password must be at least 8 chars');
    const hash = hashPassword(newPassword);
    await this.userRepo.updatePassword(userId, hash);
    await this.refreshTokenRepo.revokeAllForUser(userId);
  }
}

function sanitize(user: User): UserInfo {
  const { passwordHash, ...rest } = user;
  return rest;
}
