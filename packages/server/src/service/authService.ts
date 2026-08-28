import { randomBytes, randomUUID } from 'crypto';
import { hashPassword, verifyPassword } from './password.js';
import type { TokenService } from './tokenService.js';
import type { EmailSender } from './emailSender.js';
import type { RateLimitService } from './rateLimitService.js';
import {
  ConflictError,
  UnauthorizedError,
  UserDisabledError,
  ValidationError,
  PersonalFeatureRequiredError,
  EntityNotFoundError,
  RateLimitedError,
} from '../domain/errors.js';
import type { User, Device } from '../domain/entities.js';
import type {
  IUserRepo,
  IEmailVerificationTokenRepo,
  IPersonalSubscriptionRepo,
  IDeviceRepo,
  IRefreshTokenRepo,
  IRegistrationRepo,
} from '../repository/interfaces.js';
import type { Queryable, TxRunner } from '../repository/mysql/db.js';

/** 登录/刷新请求携带的设备字段（实施规格 §4.6 DeviceFields）。 */
export interface DeviceFields {
  deviceKey: string;
  devicePlatform: string;
  deviceName: string;
  clientVersion: string;
}

/** 脱敏用户 DTO（不含 passwordHash）。 */
export interface UserDto {
  userId: string;
  email: string;
  displayName?: string;
  emailVerified: boolean;
  status: string;
  lastLoginTime: string | null;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: UserDto;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

const VERIFICATION_TOKEN_TTL_MS = 24 * 3600 * 1000; // 24 小时
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

// 限流阈值（实施规格 §4.5）
const LOGIN_WINDOW_S = 15 * 60;
const LOGIN_MAX = 5;
const REGISTER_WINDOW_S = 3600;
const REGISTER_MAX = 10;
const VERIFY_RESEND_WINDOW_S = 3600;
const VERIFY_RESEND_MAX = 3;

/**
 * 认证服务（Facade）。
 *
 * 会话相关的多表操作（login / refresh / revokeDevice / logout）通过 `runner` 在同一
 * 连接、同一事务内完成，保证：
 * - refresh 原子轮换（锁 token 行 + 消费旧 + 写新），并发复用只产出一条有效链（§4.5）
 * - refresh 校验 device 绑定，不得把会话迁移到其他 device（§4.6）
 * - 设备撤销与 session 撤销同一事务（§4.6）
 * - 登录的设备配额检查在用户行锁下序列化，并发不超额（§4.6）
 */
export class AuthService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly emailVerificationTokenRepo: IEmailVerificationTokenRepo,
    private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo,
    private readonly deviceRepo: IDeviceRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly registrationRepo: IRegistrationRepo,
    private readonly tokenService: TokenService,
    private readonly emailSender: EmailSender,
    private readonly rateLimiter: RateLimitService,
    private readonly runner: TxRunner,
  ) {}

  /** 注册：事务建 user + Free 订阅 + 验证 token，事务提交后发验证邮件。 */
  async register(emailRaw: string, password: string, displayName?: string, ip?: string): Promise<{ ok: true }> {
    const email = normalizeEmail(emailRaw);
    this.validatePassword(password);

    await this.rateLimiter.hit(`register:ip:${ip ?? 'unknown'}`, REGISTER_WINDOW_S, REGISTER_MAX);

    const passwordHash = hashPassword(password);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.tokenService.hashToken(token);
    const expiresTime = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    try {
      await this.registrationRepo.createAccount({
        email,
        passwordHash,
        displayName,
        verificationTokenHash: tokenHash,
        verificationExpiresTime: expiresTime,
      });
    } catch (e) {
      if (e instanceof ConflictError) {
        await this.emailSender.sendAlreadyRegisteredEmail({ to: email }).catch(() => {});
        return { ok: true };
      }
      throw e;
    }

    await this.emailSender.sendVerificationEmail({ to: email, token, displayName }).catch((err) => {
      console.warn(`[auth] verification email failed`, { err: String(err) });
    });

    return { ok: true };
  }

  /** 消费初始验证 token，标记邮箱已验证（token 消费 + 标记已验同一事务）。 */
  async confirmEmail(token: string): Promise<{ ok: true }> {
    const tokenHash = this.tokenService.hashToken(token);
    const pre = await this.emailVerificationTokenRepo.findByHash(tokenHash);
    if (!pre || pre.consumedTime || pre.expiresTime <= new Date()) {
      throw new UnauthorizedError('invalid or expired verification token');
    }
    await this.runner(async (tx) => {
      const user = await this.userRepo.lockById(tx, pre.userId);
      if (!user) throw new UnauthorizedError();
      const record = await this.emailVerificationTokenRepo.findByHashForUpdate(tx, tokenHash);
      const now = new Date();
      if (!record || record.consumedTime || record.expiresTime <= now) {
        throw new UnauthorizedError('invalid or expired verification token');
      }
      // 消费 token + 标记已验，同一事务（单次消费失败则整体回滚，用户可重试）
      await this.emailVerificationTokenRepo.consume(tx, record.id, now);
      await this.userRepo.markEmailVerified(tx, user.id, now);
    });
    return { ok: true };
  }

  /**
   * 匿名重发验证 token（§4.5/§5）：不区分邮箱是否存在/已验证，响应恒为相同成功。
   * 按 email + IP 限流防枚举；仅对「存在且未验证」的用户真正作废+重建 token 并发邮件。
   */
  async resendVerification(emailRaw: string, ip?: string): Promise<{ ok: true }> {
    const email = normalizeEmail(emailRaw);

    // 每次尝试都计数（无论邮箱是否存在），防枚举 + 防滥用
    await this.rateLimiter.hit(`verify:email:${email}`, VERIFY_RESEND_WINDOW_S, VERIFY_RESEND_MAX);
    await this.rateLimiter.hit(`verify:ip:${ip ?? 'unknown'}`, VERIFY_RESEND_WINDOW_S, VERIFY_RESEND_MAX);

    const user = await this.userRepo.findByEmail(email);
    if (!user || user.emailVerifiedTime) {
      return { ok: true }; // 不存在 / 已验证：相同成功，不发邮件
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.tokenService.hashToken(token);
    const expiresTime = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    await this.runner(async (tx) => {
      // 锁用户行串行化验证 token 操作，作废+创建同一事务保证「最多一个有效 token」
      await this.userRepo.lockById(tx, user.id);
      await this.emailVerificationTokenRepo.invalidate(tx, user.id, user.email, 'initial', new Date());
      await this.emailVerificationTokenRepo.create(tx, {
        userId: user.id,
        email: user.email,
        purpose: 'initial',
        tokenHash,
        expiresTime,
      });
    });

    await this.emailSender.sendVerificationEmail({ to: email, token, displayName: user.displayName }).catch(() => {});
    return { ok: true };
  }

  /** 登录：仅已验证邮箱 + active 用户成功；失败按 email/IP 原子计数，达到阈值 429。 */
  async login(emailRaw: string, password: string, device: DeviceFields, ip?: string): Promise<AuthResponse> {
    const email = normalizeEmail(emailRaw);
    const found = await this.userRepo.findByEmail(email);
    if (!found) {
      // 未知邮箱 = 失败（§4.5）：原子计数，超阈值 429 否则 401。
      if (await this.countLoginFailure(email, ip)) throw new RateLimitedError(LOGIN_WINDOW_S);
      throw new UnauthorizedError();
    }

    const userId = found.id;
    const outcome = await this.runner(
      async (tx): Promise<{ ok: false } | { ok: true; accessToken: string; refreshToken: string; user: UserDto }> => {
        // 锁用户行：设备配额序列化 + 锁内重新校验密码，使改密前的校验结果不能跨越改密提交点。
        const user = await this.userRepo.lockById(tx, userId);
        if (!user || user.status !== 'active' || !user.emailVerifiedTime) return { ok: false };
        if (!verifyPassword(password, user.passwordHash)) return { ok: false };

        const deviceId = await this.upsertDevice(tx, user.id, device);
        const { token, hash, expiresAt } = this.tokenService.generateRefreshToken();
        await this.refreshTokenRepo.create(tx, {
          userId: user.id,
          deviceId,
          tokenHash: hash,
          familyId: randomUUID(),
          replacedByTokenId: null,
          expiresTime: expiresAt,
        });
        const accessToken = await this.tokenService.signAccessToken(user.id);
        return { ok: true, accessToken, refreshToken: token, user: sanitize(user) };
      },
    );

    if (!outcome.ok) {
      if (await this.countLoginFailure(email, ip)) throw new RateLimitedError(LOGIN_WINDOW_S);
      throw new UnauthorizedError();
    }

    await this.userRepo.updateLastLogin(userId, new Date());
    return { accessToken: outcome.accessToken, refreshToken: outcome.refreshToken, user: outcome.user };
  }

  /**
   * 登录失败原子计数（§4.5）：email 与 IP 各原子递增一次并判定，任一超阈值
   * 返回 true（调用方回 429）。用原子递增取代「peek 预检」，避免并发失败请求
   * 都读到 count<max 而全部放行。
   */
  private async countLoginFailure(email: string, ip?: string): Promise<boolean> {
    const viaEmail = await this.rateLimiter.hitExceeded(`login:email:${email}`, LOGIN_WINDOW_S, LOGIN_MAX);
    const viaIp = await this.rateLimiter.hitExceeded(`login:ip:${ip ?? 'unknown'}`, LOGIN_WINDOW_S, LOGIN_MAX);
    return viaEmail || viaIp;
  }

  /** 刷新：事务内原子轮换 + device 绑定校验 + family 复用检测。 */
  async refresh(refreshTokenStr: string, device: DeviceFields): Promise<RefreshResponse> {
    const tokenHash = this.tokenService.hashToken(refreshTokenStr);
    const pre = await this.refreshTokenRepo.findByHash(tokenHash);
    if (!pre || pre.deviceId === null) throw new UnauthorizedError();
    // 闭包里 TS 不保留属性 narrow，先固化为本地 number
    const preUserId = pre.userId;
    const preDeviceId = pre.deviceId;

    const outcome = await this.runner(
      async (tx): Promise<{ kind: 'rotated'; accessToken: string; refreshToken: string } | { kind: 'reuse'; familyId: string }> => {
        // 统一锁顺序 user -> device -> token（与 login / revokeDevice 一致，避免死锁）。
        const user = await this.userRepo.lockById(tx, preUserId);
        if (!user) throw new UnauthorizedError();
        if (user.status !== 'active') throw new UserDisabledError(user.id);

        // 设备绑定校验（§4.6）：锁 device 行，要求其 active、归属、且 deviceKey 与请求一致。
        const bound = await this.deviceRepo.findByIdForUpdate(tx, preDeviceId);
        if (!bound || bound.userId !== user.id || bound.status !== 'active' || bound.deviceKey !== device.deviceKey) {
          throw new UnauthorizedError('device mismatch');
        }
        await this.deviceRepo.touch(tx, bound.id, new Date());

        const now = new Date();
        const rt = await this.refreshTokenRepo.findByHashForUpdate(tx, tokenHash);
        if (!rt || rt.expiresTime <= now) throw new UnauthorizedError();
        if (rt.revokedTime) {
          return { kind: 'reuse', familyId: rt.familyId };
        }

        await this.refreshTokenRepo.consume(tx, rt.id, now);
        const { token, hash, expiresAt } = this.tokenService.generateRefreshToken();
        await this.refreshTokenRepo.create(tx, {
          userId: user.id,
          deviceId: rt.deviceId,
          tokenHash: hash,
          familyId: rt.familyId,
          replacedByTokenId: rt.id,
          expiresTime: expiresAt,
        });

        const accessToken = await this.tokenService.signAccessToken(user.id);
        return { kind: 'rotated', accessToken, refreshToken: token };
      },
    );

    if (outcome.kind === 'reuse') {
      // 复用检测：在**独立事务**里撤销整族（§4.5）。不能放进上面的轮换事务 ——
      // 那样 throw 会被 withTransaction 回滚，把撤销一起丢掉。
      await this.runner((tx) => this.refreshTokenRepo.revokeFamily(tx, outcome.familyId, new Date()));
      throw new UnauthorizedError('refresh token reuse detected');
    }

    return { accessToken: outcome.accessToken, refreshToken: outcome.refreshToken };
  }

  /** 登出：撤销当前 refresh token。 */
  async logout(refreshTokenStr?: string): Promise<{ ok: true }> {
    if (!refreshTokenStr) return { ok: true };
    const tokenHash = this.tokenService.hashToken(refreshTokenStr);
    await this.runner(async (tx) => {
      const rt = await this.refreshTokenRepo.findByHashForUpdate(tx, tokenHash);
      if (rt && !rt.revokedTime) {
        await this.refreshTokenRepo.consume(tx, rt.id, new Date());
      }
    });
    return { ok: true };
  }

  /** 改密：同一事务内锁用户 → 重新校验当前密码 → 更新 hash → 撤销全部 refresh token（§4.5）。 */
  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
    this.validatePassword(newPassword);
    const newHash = hashPassword(newPassword); // Argon2id 慢，事务外预计算
    await this.runner(async (tx) => {
      const user = await this.userRepo.lockById(tx, userId);
      if (!user) throw new UnauthorizedError();
      // 锁内重新校验，旧密码校验结果不能跨越改密提交点
      if (!verifyPassword(currentPassword, user.passwordHash)) throw new UnauthorizedError();
      await this.userRepo.updatePassword(tx, userId, newHash);
      await this.refreshTokenRepo.revokeAllForUser(tx, userId, new Date());
    });
    return { ok: true };
  }

  /** 列出本人设备（不含 token/hash）。 */
  async listDevices(userId: number): Promise<Device[]> {
    return this.deviceRepo.listByUser(userId);
  }

  /** 撤销设备：同一事务内撤销 device + 该 device 全部 session（§4.6）。 */
  async revokeDevice(userId: number, deviceId: number): Promise<{ ok: true }> {
    await this.runner(async (tx) => {
      // 统一锁顺序 user -> device -> token（先锁用户行串行化该用户所有会话操作）。
      await this.userRepo.lockById(tx, userId);
      const device = await this.deviceRepo.findByIdForUpdate(tx, deviceId);
      if (!device || device.userId !== userId) throw new EntityNotFoundError('device', deviceId);
      const now = new Date();
      await this.deviceRepo.revoke(tx, device.id, now);
      await this.refreshTokenRepo.revokeByDevice(tx, device.id, now);
    });
    return { ok: true };
  }

  /** 校验密码长度（12..128 Unicode code points）。 */
  private validatePassword(password: string): void {
    const len = Array.from(password).length;
    if (len < PASSWORD_MIN || len > PASSWORD_MAX) {
      throw new ValidationError(`password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`);
    }
  }

  /**
   * 设备 upsert + 设备数上限约束（§4.6）。在用户行锁（调用方事务）内执行。
   */
  private async upsertDevice(exec: Queryable, userId: number, device: DeviceFields): Promise<number | null> {
    if (!device?.deviceKey) return null;
    const maxDevices = await this.maxDevices(userId);
    const existing = await this.deviceRepo.findByUserAndKey(exec, userId, device.deviceKey);
    if ((!existing || existing.status !== 'active') && maxDevices > 0) {
      const activeCount = await this.deviceRepo.countActive(exec, userId);
      if (activeCount >= maxDevices) throw new PersonalFeatureRequiredError('maxDevices');
    }
    const saved = await this.deviceRepo.upsert(exec, {
      userId,
      deviceKey: device.deviceKey,
      devicePlatform: device.devicePlatform ?? '',
      deviceName: device.deviceName ?? '',
      clientVersion: device.clientVersion ?? '',
      status: 'active',
      lastUsedTime: new Date(),
    });
    return saved.id;
  }

  private async maxDevices(userId: number): Promise<number> {
    const sub = await this.personalSubscriptionRepo.findByUserId(userId);
    const n = sub?.entitlementSnapshot?.maxDevices;
    return typeof n === 'number' ? n : 0;
  }
}

function normalizeEmail(emailRaw: string): string {
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
  if (!email || email.length > 255 || !email.includes('@')) {
    throw new ValidationError('invalid email');
  }
  return email;
}

function sanitize(user: User): UserDto {
  return {
    userId: String(user.id),
    email: user.email,
    displayName: user.displayName,
    emailVerified: !!user.emailVerifiedTime,
    status: user.status,
    lastLoginTime: user.lastLoginTime ? user.lastLoginTime.toISOString() : null,
  };
}