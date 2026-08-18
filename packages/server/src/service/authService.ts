import type { IUserRepo, ISubscriptionRepo, IRefreshTokenRepo, IDeviceRepo } from '../repository/interfaces.js';
import type { TokenService } from './tokenService.js';
import type { Subscription, User, SessionInfo, Device } from '../domain/entities.js';
import { hashPassword, verifyPassword } from './password.js';
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
    if (!user || !verifyPassword(password, user.passwordHash)) throw new InvalidCredentialsError();
    if (user.status !== 'active') throw new InvalidCredentialsError();

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

    if (rt.expiresTime <= now) throw new InvalidCredentialsError();

    // 原子消费：条件更新的 affectedRows 是唯一判据。
    //
    // 不能用「先判 rt.revokedTime 再 revoke」—— 那中间有 await（事件循环让出点），
    // 两个带同一个 token 的并发请求会双双通过检查、各自签出新会话，于是
    // refresh token 的一次性保证失效、`refresh_tokens` 出现两条活跃行、
    // 重用检测在最需要它的场景下静默失灵。
    //
    // consume 返回 false 有两种成因：并发下输给了另一个请求，或这是一个已被
    // 轮换掉的旧 token 被重放。两者在安全语义上同等 —— 都说明这个 token 已经
    // 不该再被接受，一律按泄露处理，撤销该用户全部会话。
    if (!(await this.refreshTokenRepo.consume(rt.id, now))) {
      await this.refreshTokenRepo.revokeAllForUser(rt.userId);
      throw new TokenReuseError(rt.id, rt.userId);
    }

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

  /**
   * 登出。
   *
   * 语义底线是**发起登出的那条会话一定要死掉**，所以以 `sid`（access token 里
   * 携带的、签发它的 refresh token 行 id）为准，而不是以传入的 refresh token 为准。
   *
   * 原实现只按传入的 refresh token 查找并撤销，且「找不到」与「已撤销」都静默
   * 返回成功。真实攻击链：攻击者窃取 R1 并抢先 refresh → 服务端撤销 R1、签出
   * 攻击者的 R2 → 受害者察觉异常点「退出登录」，客户端发送它手上的 R1 →
   * 服务端发现 R1 已撤销 → 无操作、返回 200 → 攻击者的会话完好无损，而受害者
   * 以为已经登出。
   *
   * 另外，同一个已撤销 token 出现在 refresh 时会触发 revokeAllForUser，出现在
   * logout 时却什么都不做 —— 面对同一个泄露信号，两条路径的处置不该不对称。
   *
   * @param sid   当前 access token 的会话 id（权威）
   * @param userId 当前用户 id，用于归属校验，防止用他人 sid 越权撤销
   * @param refreshTokenStr 客户端持有的 refresh token（可选）
   */
  async logout(sid: number, userId: number, refreshTokenStr?: string): Promise<void> {
    // 1. 当前会话：仅在归属本人时撤销
    const current = await this.refreshTokenRepo.findById(sid);
    if (current && current.userId === userId) {
      await this.refreshTokenRepo.revoke(sid);
    }

    if (!refreshTokenStr) return;

    const rt = await this.refreshTokenRepo.findByHash(this.tokenService.hashToken(refreshTokenStr));
    if (!rt || rt.userId !== userId) return; // 不是自己的 token，忽略

    if (rt.revokedTime && rt.id !== sid) {
      // 出示一个已被轮换掉的 token：与 refresh 侧同等对待，按泄露处理
      await this.refreshTokenRepo.revokeAllForUser(userId);
      return;
    }
    await this.refreshTokenRepo.revoke(rt.id);
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
    if (!verifyPassword(oldPassword, user.passwordHash)) throw new InvalidCredentialsError();
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