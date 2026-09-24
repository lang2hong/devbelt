import { randomBytes, randomUUID } from 'crypto';
import { hashPassword, verifyPassword } from './password.js';
import { sanitizeDisplayName } from './displayName.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { EmailSender } from './emailSender.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import {
  ConflictError,
  UnauthorizedError,
  UserDisabledError,
  ValidationError,
  PersonalFeatureRequiredError,
  EntityNotFoundError,
  RateLimitedError,
  InvalidCurrentPasswordError,
} from '../../../domain/errors.js';
import type { User, Device } from '../../../domain/entities.js';
import { EXTENSION_SCOPES } from '../../../domain/enums.js';
import type {
  IUserRepo,
  IEmailVerificationTokenRepo,
  IPersonalSubscriptionRepo,
  IPlanRepo,
  IDeviceRepo,
  IRefreshTokenRepo,
  IRegistrationRepo,
} from '../../../repository/interfaces.js';
import type { Queryable, TxRunner } from '../../../repository/mysql/db.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import { deriveEntitlement } from '../../billing/service/entitlement.js';

/** 登录/刷新请求携带的设备字段（实施规格 §5.2 DeviceFields）。 */
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
const PASSWORD_MIN = 9;
const PASSWORD_MAX = 128;

// 限流阈值（实施规格 §5.2）
const LOGIN_WINDOW_S = 15 * 60;
const LOGIN_MAX = 5;
/**
 * 登录滥用硬上限（同窗口、同桶的失败次数）。仅用于在 Argon2id 之前廉价拒绝，
 * 不改变「失败才计数、正确密码不被锁」的认证语义，故必须 > LOGIN_MAX。
 * 20 次失败 × ~2.5s 即约 50s CPU，是单个 (email|ip, 15min) 的最坏开销上界。
 */
const LOGIN_ABUSE_MAX = 20;
const REGISTER_WINDOW_S = 3600;
const REGISTER_MAX = 10;
const VERIFY_RESEND_WINDOW_S = 3600;
const VERIFY_RESEND_MAX = 3;
/**
 * 改密限流：本端点每次都会做 Argon2id（慢），已认证者反复调用会持续占用
 * CPU/worker，必须按用户节流。
 */
const CHANGE_PASSWORD_WINDOW_S = 15 * 60;
const CHANGE_PASSWORD_MAX = 10;

/**
 * 认证服务（Facade）。
 *
 * 会话相关的多表操作（login / refresh / revokeDevice / logout）通过 `runner` 在同一
 * 连接、同一事务内完成，保证：
 * - refresh 原子轮换（锁 token 行 + 消费旧 + 写新），并发复用只产出一条有效链（§5.1）
 * - refresh 校验 device 绑定，不得把会话迁移到其他 device（§5.1）
 * - 设备撤销与 session 撤销同一事务（§5.1）
 * - 登录的设备配额检查在用户行锁下序列化，并发不超额（§5.1）
 */
/** refresh 重放宽限（见 reuse 处理）：同一客户端并发/重试重放刚轮换掉的旧 token 时，
 * 只拒绝本次、不吊销整族，避免一次竞态把该设备登出。 */
export const REFRESH_REUSE_GRACE_MS = 60_000;

export class AuthService {
  constructor(
    private readonly userRepo: IUserRepo,
    private readonly emailVerificationTokenRepo: IEmailVerificationTokenRepo,
    private readonly personalSubscriptionRepo: IPersonalSubscriptionRepo,
    private readonly planRepo: IPlanRepo,
    private readonly deviceRepo: IDeviceRepo,
    private readonly refreshTokenRepo: IRefreshTokenRepo,
    private readonly registrationRepo: IRegistrationRepo,
    private readonly tokenService: TokenService,
    private readonly emailSender: EmailSender,
    private readonly rateLimiter: RateLimitService,
    private readonly runner: TxRunner,
    private readonly auditWriter?: AuditWriter,
  ) {}

  /** 注册：事务建 user + Free 订阅 + 验证 token，事务提交后发验证邮件。 */
  async register(emailRaw: string, password: string, displayName?: string, ip?: string): Promise<{ ok: true }> {
    const email = normalizeEmail(emailRaw);
    this.validatePassword(password);
    const sanitizedDisplayName = displayName !== undefined ? sanitizeDisplayName(displayName) : undefined;

    await this.rateLimiter.hit(`register:ip:${ip ?? 'unknown'}`, REGISTER_WINDOW_S, REGISTER_MAX);

    const passwordHash = await hashPassword(password);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.tokenService.hashToken(token);
    const expiresTime = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    try {
      await this.registrationRepo.createAccount({
        email,
        passwordHash,
        displayName: sanitizedDisplayName,
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
      this.auditWriter?.write({ eventType: 'email.verify.failed', result: 'failure', targetType: 'email_verification_token' });
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
    this.auditWriter?.write({ eventType: 'email.verify.consumed', result: 'success', actorUserId: pre.userId, targetType: 'email_verification_token' });
    return { ok: true };
  }

  /**
   * 匿名重发验证 token（§5.1/§5.2）：不区分邮箱是否存在/已验证，响应恒为相同成功。
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

    // 滥用闸（≠ 认证节流）：在 **Argon2id 之前**廉价拒绝，防止「超限请求依然各烧
    // ~2.5s CPU」把事件循环占满。
    //
    // 阈值刻意取 LOGIN_ABUSE_MAX 而**不是** LOGIN_MAX：本端点的既有语义是
    // 「只对失败计数，密码正确者永不被锁」（§5.2）。若在 LOGIN_MAX 上做前置拒绝，
    // 攻击者只要替受害者打满 5 次失败，就能把真正的用户挡在门外 15 分钟 ——
    // 那正是原设计特意规避的账号锁定型 DoS。
    //
    // 于是两条阈值各司其职：
    //   LOGIN_MAX(5)        失败后判定，回 429，但不阻止正确密码通过；
    //   LOGIN_ABUSE_MAX(20) 同一桶失败到该量级即视为滥用，后续请求不再算 argon2。
    // 计数桶只在失败时递增，所以从未失败过的正常用户恒为 0，不受影响。
    await this.rateLimiter.assertUnder(`login:email:${email}`, LOGIN_WINDOW_S, LOGIN_ABUSE_MAX);
    await this.rateLimiter.assertUnder(`login:ip:${ip ?? 'unknown'}`, LOGIN_WINDOW_S, LOGIN_ABUSE_MAX);

    const found = await this.userRepo.findByEmail(email);
    if (!found) {
      // 未知邮箱 = 失败（§5.2）：原子计数，超阈值 429 否则 401。
      if (await this.countLoginFailure(email, ip)) throw new RateLimitedError(LOGIN_WINDOW_S);
      throw new UnauthorizedError();
    }

    const userId = found.id;

    // Argon2id（~2.5s）在**事务与行锁之外**计算。原实现放在 lockById 之后，
    // 意味着每次登录都持有该用户的行锁 + 一条池连接约 2.5s：同账号并发登录被串行化，
    // 数十个并发即超过 innodb_lock_wait_timeout 开始报错。
    //
    // 原注释给出的理由（锁内复核，使校验结果不能跨越改密提交点）依然成立，做法改为：
    // 锁外用 found.passwordHash 验密码，锁内只比对 hash **串本身**有没有变。
    // 并发改密会改写 password_hash，锁内比对即失配 → 拒绝。等价的防护，
    // 但昂贵计算不再占着锁。
    const passwordOk = await verifyPassword(password, found.passwordHash);
    const verifiedAgainstHash = found.passwordHash;

    const outcome = await this.runner(
      async (tx): Promise<{ ok: false } | { ok: true; accessToken: string; refreshToken: string; user: UserDto }> => {
        // 锁用户行：设备配额序列化 + 复核密码校验所依据的 hash 未被并发改密取代。
        const user = await this.userRepo.lockById(tx, userId);
        if (!user || user.status !== 'active' || !user.emailVerifiedTime) return { ok: false };
        if (!passwordOk) return { ok: false };
        // 锁外的校验依据已过期（期间发生改密）→ 视为失败，不放行。
        if (user.passwordHash !== verifiedAgainstHash) return { ok: false };

        const deviceId = await this.upsertDevice(tx, user.id, device);
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
          aud: 'extension',
          scope: [...EXTENSION_SCOPES],
          sessionId: familyId,
          deviceId: deviceId ?? undefined,
          sessionVersion: user.sessionVersion,
        });
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
   * 登录失败原子计数（§5.2）：email 与 IP 各原子递增一次并判定，任一超阈值
   * 返回 true（调用方回 429）。用原子递增取代「peek 预检」，避免并发失败请求
   * 都读到 count<max 而全部放行。
   */
  private async countLoginFailure(email: string, ip?: string): Promise<boolean> {
    const viaEmail = await this.rateLimiter.hitExceeded(`login:email:${email}`, LOGIN_WINDOW_S, LOGIN_MAX);
    const viaIp = await this.rateLimiter.hitExceeded(`login:ip:${ip ?? 'unknown'}`, LOGIN_WINDOW_S, LOGIN_MAX);
    return viaEmail || viaIp;
  }

  /** 刷新：事务内原子轮换 + device 绑定校验 + family 复用检测。 */
/** 刷新：事务内原子轮换 + device 绑定校验 + family 复用检测（重放宽限见具体实现）。 */
  async refresh(refreshTokenStr: string, device: DeviceFields): Promise<RefreshResponse> {
    const tokenHash = this.tokenService.hashToken(refreshTokenStr);
    const pre = await this.refreshTokenRepo.findByHash(tokenHash);
    if (!pre || pre.deviceId === null) throw new UnauthorizedError();
    // 闭包里 TS 不保留属性 narrow，先固化为本地 number
    const preUserId = pre.userId;
    const preDeviceId = pre.deviceId;

    const outcome = await this.runner(
      async (tx): Promise<{ kind: 'rotated'; accessToken: string; refreshToken: string } | { kind: 'reuse'; familyId: string; revokedTime: Date }> => {
        // 统一锁顺序 user -> device -> token（与 login / revokeDevice 一致，避免死锁）。
        const user = await this.userRepo.lockById(tx, preUserId);
        if (!user) throw new UnauthorizedError();
        if (user.status !== 'active') throw new UserDisabledError(user.id);

        // 设备绑定校验（§5.1）：锁 device 行，要求其 active、归属、且 deviceKey 与请求一致。
        const bound = await this.deviceRepo.findByIdForUpdate(tx, preDeviceId);
        if (!bound || bound.userId !== user.id || bound.status !== 'active' || bound.deviceKey !== device.deviceKey) {
          throw new UnauthorizedError('device mismatch');
        }
        await this.deviceRepo.touch(tx, bound.id, new Date());

        const now = new Date();
        const rt = await this.refreshTokenRepo.findByHashForUpdate(tx, tokenHash);
        if (!rt || rt.expiresTime <= now) throw new UnauthorizedError();
        if (rt.revokedTime) {
          return { kind: 'reuse', familyId: rt.familyId, revokedTime: rt.revokedTime };
        }

        await this.refreshTokenRepo.consume(tx, rt.id, now);
        const { token, hash, expiresAt } = this.tokenService.generateRefreshToken();
        await this.refreshTokenRepo.create(tx, {
          userId: user.id,
          deviceId: rt.deviceId,
          tokenHash: hash,
          familyId: rt.familyId,
          expiresTime: expiresAt,
        });

        const accessToken = await this.tokenService.signAccessToken({
          userId: user.id,
          aud: 'extension',
          scope: [...EXTENSION_SCOPES],
          sessionId: rt.familyId,
          deviceId: rt.deviceId ?? undefined,
          sessionVersion: user.sessionVersion,
        });
        return { kind: 'rotated', accessToken, refreshToken: token };
      },
    );

    if (outcome.kind === 'reuse') {
      // 良性重放大赦：旧 token 是**最近**（≤宽限）才被撤销、且族内仍有活跃 token
      // （说明新 token 已签发给合法客户端）。此时并发/重试重放只拒绝本次，不吊销整族；
      // 陈旧客户端下次会从存储读到新 token 自愈。
      const benign = Date.now() - outcome.revokedTime.getTime() <= REFRESH_REUSE_GRACE_MS
        && (await this.refreshTokenRepo.hasActiveToken(outcome.familyId));
      if (benign) throw new UnauthorizedError('refresh token already rotated');
      // 真·复用检测：在**独立事务**里撤销整族（§5.1）。不能放进上面的轮换事务 ——
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

  /** 改密：同一事务内锁用户 → 重新校验当前密码 → 更新 hash → 撤销全部 refresh token（§5.1）。 */
  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
    // 限流先于任何 Argon2id：否则已认证者可反复触发慢哈希（见 CHANGE_PASSWORD_*）。
    await this.rateLimiter.hit(`change-password:user:${userId}`, CHANGE_PASSWORD_WINDOW_S, CHANGE_PASSWORD_MAX);
    this.validatePassword(newPassword);

    // 先校验旧密码、再计算新 hash：旧密码错误时只需一次 Argon2id 而非两次。
    // 两次哈希都放在事务外（与 login 一致）：放入锁内会让用户行锁与池连接被占用约 5s。
    const current = await this.userRepo.findById(userId);
    if (!current) throw new UnauthorizedError();
    const currentOk = await verifyPassword(currentPassword, current.passwordHash);
    const verifiedAgainstHash = current.passwordHash;
    // 旧密码错误时不再计算新 hash：失败路径少一次 Argon2id（真正的护栏是上面的限流）。
    const newHash = currentOk ? await hashPassword(newPassword) : '';

    await this.runner(async (tx) => {
      const user = await this.userRepo.lockById(tx, userId);
      if (!user) throw new UnauthorizedError();
      if (!currentOk) throw new InvalidCurrentPasswordError();
      // 锁内复核校验依据未被并发改密取代（防两个改密请求都基于同一旧 hash 通过）。
      if (user.passwordHash !== verifiedAgainstHash) throw new InvalidCurrentPasswordError();
      await this.userRepo.updatePassword(tx, userId, newHash);
      // 改密使所有存量会话失效：session_version +1 让 access token 立即失效（§4.1），
      // 再撤销全部 refresh family 让 refresh 也无法续期。
      await this.userRepo.incrementSessionVersion(tx, userId);
      await this.refreshTokenRepo.revokeAllForUser(tx, userId, new Date());
    });
    return { ok: true };
  }

  /**
   * 账号恢复第二步（step-up）登临：`POST /api/db/sync/recover-via-account` 会把数据
   * 解密的原材料（accountRecoveryKey + envelopeAccount）下发给调用者，其安全边界
   * 因此不能仅凭一个普通 sync access token —— token 泄露者即使拿不到用户的账号
   * 登录口令，也能凭 token 拿到 DEK 材料并离线解密全部同步数据。故此处强制再复核
   * 一次账户登录口令（调用者已登录，但需重新输入口令自证身份）。
   *
   * 校验失败抛 INVALID_CURRENT_PASSWORD（400，已认证用户无账号枚举风险），
   * 与改密的现有语义一致；账户不存在/未认证则抛 UNAUTHORIZED。
   */
  async verifyPasswordStepUp(userId: number, password: string): Promise<void> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new UnauthorizedError();
    if (!(await verifyPassword(password, user.passwordHash))) throw new InvalidCurrentPasswordError();
  }

  /** 列出本人设备（不含 token/hash）。 */
  async listDevices(userId: number): Promise<Device[]> {
    return this.deviceRepo.listByUser(userId);
  }

  /** 撤销设备：同一事务内撤销 device + 该 device 全部 session（§5.1）。 */
  async revokeDevice(userId: number, deviceId: number): Promise<{ ok: true }> {
    await this.runner((tx) => this.revokeDeviceInTx(tx, userId, deviceId));
    return { ok: true };
  }

  /** 撤销设备的在事务内实现（幂等回执下与业务写、审计同事务）。 */
  async revokeDeviceInTx(tx: Queryable, userId: number, deviceId: number): Promise<{ ok: true }> {
    // 统一锁顺序 user -> device -> token（先锁用户行串行化该用户所有会话操作）。
    await this.userRepo.lockById(tx, userId);
    const device = await this.deviceRepo.findByIdForUpdate(tx, deviceId);
    if (!device || device.userId !== userId) throw new EntityNotFoundError('device', deviceId);
    const now = new Date();
    await this.deviceRepo.revoke(tx, device.id, now);
    await this.refreshTokenRepo.revokeByDevice(tx, device.id, now);
    return { ok: true };
  }

  /** 校验密码长度（9..128 Unicode code points）。 */
  private validatePassword(password: string): void {
    const len = Array.from(password).length;
    if (len < PASSWORD_MIN || len > PASSWORD_MAX) {
      throw new ValidationError(`password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`);
    }
  }

  /**
   * 设备 upsert + 设备数上限约束（§5.1）。在用户行锁（调用方事务）内执行。
   */
  private async upsertDevice(exec: Queryable, userId: number, device: DeviceFields): Promise<number | null> {
    if (!device?.deviceKey) return null;
    // 'web' 平台是控制台单槽位专用（服务端硬编码），扩展不得谎报以绕过 maxDevices（§4.1）。
    if (device.devicePlatform === 'web') {
      throw new ValidationError('devicePlatform "web" is reserved for the web console');
    }
    const maxDevices = await this.maxDevices(exec, userId);
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

  /**
   * 读设备配额。**必须接受调用方的 `exec`**：本方法只在 `upsertDevice` 里被调用，
   * 而那是在 login 事务的用户行锁内。若改用连接池（`findByUserId`），该请求会在
   * 持有事务连接的同时再向池申请第二条连接 —— 并发数达到 connectionLimit 时
   * 所有请求互相等待，且 mysql2 没有获取超时，进程永久死锁只能重启。
   * 顺带：走同一事务才能让配额读落在用户行锁的快照内，配额检查才真正被序列化。
   */
  private async maxDevices(exec: Queryable, userId: number): Promise<number> {
    const sub = await this.personalSubscriptionRepo.findByUserIdInTx(exec, userId);
    const plan = sub ? await this.planRepo.findByIdInTx(exec, sub.planId) : undefined;
    const freePlan = await this.planRepo.findByCodeInTx(exec, 'free');
    const n = deriveEntitlement(sub, plan, freePlan).maxDevices;
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