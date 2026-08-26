import type {
  IUserRepo, ISubscriptionRepo, IRefreshTokenRepo, IDeviceRepo, IRegistrationRepo,
  IMembershipRepo,
} from '../repository/interfaces.js';
import type { TokenService } from './tokenService.js';
import type { Subscription, User, Device } from '../domain/entities.js';
import { hashPassword, verifyPassword } from './password.js';
import type { PlanPolicy } from '../policy/planPolicy.js';
import {
  InvalidCredentialsError,
  ProFeatureRequiredError,
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

/**
 * 认证服务（Facade）：协调 registration/user/subscription/refreshToken/device repo + TokenService。
 * 职责：注册/登录/刷新/登出/会话管理。
 *
 * v2：注册走 IRegistrationRepo 原子创建 user + personal org + membership + free
 * 订阅 + 席位；设备配额与功能门控由 PlanPolicy 按「有效席位套餐」解析，不再读 user.planCode。
 */
export class AuthService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly subRepo: ISubscriptionRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly deviceRepo: IDeviceRepo,
    private readonly registrationRepo: IRegistrationRepo,
    private readonly tokenService: TokenService,
    private readonly planPolicy: PlanPolicy,
    private readonly membershipRepo: IMembershipRepo,
  ) {}

  /** 注册：原子建 user + personal org + membership + free 订阅 + 席位，再签双 token */
  async register(email: string, password: string, device?: DeviceInfo): Promise<AuthResponse> {
    if (!email || !password) throw new InvalidCredentialsError();
    if (typeof email !== 'string' || !email.includes('@')) throw new ValidationError('invalid email format');
    if (password.length < 8) throw new ValidationError('password must be at least 8 chars');

    const exist = await this.userRepo.findByEmail(email);
    if (exist) throw new InvalidCredentialsError();

    const hash = hashPassword(password);
    const { userId, organizationId } = await this.registrationRepo.createAccount({
      email: email.trim().toLowerCase(),
      passwordHash: hash,
      role: 'user',
    });

    const user = await this.userRepo.findById(userId);
    if (!user) throw new Error('user create failed');

    if (device?.deviceId) {
      await this.deviceRepo.upsert(toDevice(user.id, device));
      await this.tryBindDevice(user.id, device);
    }

    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
    const rt = await this.refreshTokenRepo.create(tokenForCreate(user.id, rtHash, device, expiresAt));
    const accessToken = this.tokenService.signAccessToken(user.id, user.role, rt.id);
    await this.userRepo.updateLastLogin(user.id, new Date());

    const subscription = await this.subRepo.findByOrganizationId(organizationId);
    return { accessToken, refreshToken: token, user: sanitize(user), subscription };
  }

  /** 登录：校验凭据 + 设备判同 + 设备数检查 + 签双 token */
  async login(email: string, password: string, device?: DeviceInfo): Promise<AuthResponse> {
    if (!email || !password) throw new InvalidCredentialsError();
    const user = await this.userRepo.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) throw new InvalidCredentialsError();
    if (user.status !== 'active') throw new InvalidCredentialsError();

    if (device?.deviceId) {
      await this.deviceRepo.upsert(toDevice(user.id, device));
      await this.refreshTokenRepo.revokeByDevice(user.id, device.deviceId);
    }

    const now = new Date();
    await this.tryBindDevice(user.id, device);

    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
    const rt = await this.refreshTokenRepo.create(tokenForCreate(user.id, rtHash, device, expiresAt));
    const accessToken = this.tokenService.signAccessToken(user.id, user.role, rt.id);
    await this.userRepo.updateLastLogin(user.id, now);

    return { accessToken, refreshToken: token, user: sanitize(user), subscription: await this.findPersonalSubscription(user.id) };
  }

  /** P3-18: 找用户的 personal org 订阅（login 响应对齐 register） */
  private async findPersonalSubscription(userId: number): Promise<Subscription | undefined> {
    const memberships = await this.membershipRepo.listByUser(userId);
    for (const m of memberships) {
      const sub = await this.subRepo.findByOrganizationId(m.organizationId);
      if (sub) return sub;
    }
    return undefined;
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

    if (!(await this.refreshTokenRepo.consume(rt.id, now))) {
      await this.refreshTokenRepo.revokeAllForUser(rt.userId);
      throw new TokenReuseError(rt.id, rt.userId);
    }

    const { token, hash: rtHash, expiresAt } = this.tokenService.generateRefreshToken();
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

    if (user.status !== 'active') {
      await this.refreshTokenRepo.revokeAllForUser(user.id);
      throw new UserDisabledError(user.id);
    }

    const accessToken = this.tokenService.signAccessToken(user.id, user.role, newRt.id);
    return { accessToken, refreshToken: token };
  }

  /**
   * 登出。语义底线是发起登出的那条会话一定要死掉，所以以 sid（access token 里
   * 携带的、签发它的 refresh token 行 id）为准，而不是以传入的 refresh token 为准。
   */
  async logout(sid: number, userId: number, refreshTokenStr?: string): Promise<void> {
    const current = await this.refreshTokenRepo.findById(sid);
    if (current && current.userId === userId) {
      await this.refreshTokenRepo.revoke(sid);
    }

    if (!refreshTokenStr) return;

    const rt = await this.refreshTokenRepo.findByHash(this.tokenService.hashToken(refreshTokenStr));
    if (!rt || rt.userId !== userId) return;

    if (rt.revokedTime && rt.id !== sid) {
      await this.refreshTokenRepo.revokeAllForUser(userId);
      return;
    }
    await this.refreshTokenRepo.revoke(rt.id);
  }

  /** 列出当前用户全部设备（含绑定状态 revokedTime） */
  async listDevices(userId: number): Promise<Device[]> {
    return this.deviceRepo.listByUser(userId);
  }

  /** 撤销设备（释放配额位）。只有 free 全套用户不可自助撤销（防「撤销=共享」） */
  async revokeDevice(userId: number, deviceId: string): Promise<void> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new InvalidCredentialsError();
    const plans = await this.planPolicy.effectivePlans(userId);
    const isFree = plans.length === 0 || plans.every((p) => p.code === 'free');
    if (isFree) throw new ProFeatureRequiredError('device management');
    await this.deviceRepo.revoke(userId, deviceId);
    await this.refreshTokenRepo.revokeByDevice(userId, deviceId);
  }

  /** 尝试绑定设备（登录/注册用）：未绑定且配额未满才绑定；满则保持未激活，不抛错。
   *  超限设备由 sync 层硬卡（403），引导升级或联系管理员。 */
  private async tryBindDevice(userId: number, device?: DeviceInfo): Promise<void> {
    if (!device?.deviceId) return;
    const limit = await this.planPolicy.limit(userId, 'devices');
    if (limit <= 0) return; // 0 = 无限
    if (await this.deviceRepo.isBound(userId, device.deviceId)) return;
    const bound = await this.deviceRepo.countBound(userId);
    if (bound < limit) await this.deviceRepo.bind(userId, device.deviceId);
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

/** 组装 devices 表行（设备固有信息）。v2 无 os_machine_id（device_id 即 OS machine id） */
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