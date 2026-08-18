import type { IUserRepo, ISubscriptionRepo, IRefreshTokenRepo, IDeviceRepo } from '../repository/interfaces.js';
import type { TokenService } from './tokenService.js';
import type { Subscription, User, SessionInfo, Device } from '../domain/entities.js';
import { hashPassword, upgradePasswordIfNeeded, verifyPassword } from './password.js';
import {
  InvalidCredentialsError,
  TokenReuseError,
  UserDisabledError,
  ValidationError,
} from '../domain/errors.js';

/** 设备信息（登录/刷新时上报；deviceId 为同设备判同键） */
export interface DeviceInfo {
  deviceName?: string;
  deviceId?: string;
  machineId?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  osVersion?: string;
  appName?: string;
  appVersion?: string;
  remoteName?: string;
  language?: string;
  timezone?: string;
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
 * 认证服务（Facade）：协调 user/subscription/refreshToken/device repo + TokenService。
 * 职责：注册/登录/刷新/登出/会话管理。
 * 令牌策略：access JWT 短期 + refresh 随机 token（hash 存库）+ 轮换 + 重用检测。
 * 设备判同：同 user+deviceId 重登先 upsert 设备实体 + 撤销该设备旧会话，设备数恒定。
 */
export class AuthService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly deviceRepo: IDeviceRepo,
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

    if (device?.deviceId) await this.deviceRepo.upsert(toDevice(user.id, device));

    const periodEnd = new Date(Date.now() + TRIAL_DAYS * 86400000);
    const subscription = await this.subRepo.upsert({
      userId: user.id, planCode: 'free', status: 'trialing',
      periodEndTime: periodEnd, trialEndTime: periodEnd, provider: 'manual',
    });

    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
    const rt = await this.refreshTokenRepo.create(tokenForCreate(user.id, rtHash, device, expiresAt));
    const accessToken = this.tokenService.signAccessToken(user.id, user.role, user.planCode, rt.id);
    await this.userRepo.updateLastLogin(user.id, new Date());

    return { accessToken, refreshToken: token, user: sanitize(user), subscription };
  }

  /** 登录：校验凭据 + 设备判同 + 设备数检查 + 签双 token */
  async login(email: string, password: string, device?: DeviceInfo): Promise<AuthResponse> {
    if (!email || !password) throw new InvalidCredentialsError();
    const user = await this.userRepo.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash, this.jwtSecret)) throw new InvalidCredentialsError();
    if (user.status !== 'active') throw new InvalidCredentialsError();

    // 旧 sha256 哈希登录成功后就地升级为 scrypt。
    // 不升级的话这批用户永远停在弱哈希上，且其 legacySalt 取自 JWT_SECRET —— 
    // 一旦轮换 JWT 密钥，他们的密码就再也验不过。升级失败不阻断登录。
    if (upgradePasswordIfNeeded(user.passwordHash)) {
      try {
        await this.userRepo.updatePassword(user.id, hashPassword(password));
      } catch { /* 升级是尽力而为，不影响本次登录 */ }
    }

    // 设备判同：先登记设备固有信息，再顶掉该设备旧会话（同设备重登不叠加会话）
    if (device?.deviceId) {
      await this.deviceRepo.upsert(toDevice(user.id, device));
      await this.refreshTokenRepo.revokeByDevice(user.id, device.deviceId);
    }

    const now = new Date();

    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
    const rt = await this.refreshTokenRepo.create(tokenForCreate(user.id, rtHash, device, expiresAt));
    const accessToken = this.tokenService.signAccessToken(user.id, user.role, user.planCode, rt.id);
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
    // 继承旧 token 的设备字段（刷新请求未带时用旧值），保持同设备会话延续
    const newRt = await this.refreshTokenRepo.create({
      userId: rt.userId,
      tokenHash: rtHash,
      deviceName: device?.deviceName ?? rt.deviceName,
      deviceId: device?.deviceId ?? rt.deviceId,
      userAgent: device?.userAgent ?? rt.userAgent,
      ip: device?.ip ?? rt.ip,
      expiresTime: expiresAt,
    });

    const user = await this.userRepo.findById(rt.userId);
    if (!user) throw new InvalidCredentialsError();

    // 被禁用的账号不得续期。
    //
    // 少了这一条，「禁用」在实现层面等于无效：requireAuth 只校验 JWT 签名，
    // 而这里只判 user 是否存在 —— 用户可以拿 refresh 无限换新 access token，
    // 永久保有访问权。顺手撤销其全部会话，避免它继续持有其他设备的 refresh。
    if (user.status !== 'active') {
      await this.refreshTokenRepo.revokeAllForUser(user.id);
      throw new UserDisabledError(user.id);
    }

    const accessToken = this.tokenService.signAccessToken(user.id, user.role, user.planCode, newRt.id);
    return { accessToken, refreshToken: token };
  }

  /** 登出：撤销当前 refresh token */
  async logout(refreshTokenStr: string): Promise<void> {
    const hash = this.tokenService.hashToken(refreshTokenStr);
    const rt = await this.refreshTokenRepo.findByHash(hash);
    if (rt && !rt.revokedTime) await this.refreshTokenRepo.revoke(rt.id);
  }

  /** 列出当前用户活跃会话 */
  async listSessions(userId: number, currentRefreshId?: number): Promise<SessionInfo[]> {
    const sessions = await this.refreshTokenRepo.listActiveForUser(userId, new Date());
    return sessions.map((s) => ({ ...s, current: currentRefreshId != null && s.id === currentRefreshId }));
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

/** 组装 refresh_tokens 行（仅会话字段，设备固有信息不入会话表） */
function tokenForCreate(
  userId: number,
  tokenHash: string,
  device: DeviceInfo | undefined,
  expiresAt: Date,
): Omit<import('../domain/entities.js').RefreshToken, 'id' | 'createTime' | 'updateTime'> {
  return {
    userId,
    tokenHash,
    deviceName: device?.deviceName,
    deviceId: device?.deviceId,
    userAgent: device?.userAgent,
    ip: device?.ip,
    expiresTime: expiresAt,
  };
}

/** 组装 devices 表行（设备固有信息） */
function toDevice(userId: number, device: DeviceInfo): Omit<Device, 'id' | 'createTime' | 'updateTime'> {
  return {
    userId,
    deviceId: device.deviceId!,
    hostname: device.hostname,
    os: device.os,
    arch: device.arch,
    osVersion: device.osVersion,
    appName: device.appName,
    appVersion: device.appVersion,
    remoteName: device.remoteName,
    vsMachineId: device.machineId,
    language: device.language,
    timezone: device.timezone,
    lastSeenTime: new Date(),
  };
}

function sanitize(user: User): UserInfo {
  const { passwordHash, ...rest } = user;
  return rest;
}