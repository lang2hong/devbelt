import type {
  User,
  EmailVerificationToken,
  PersonalSubscription,
  Device,
  RefreshToken,
} from "../../domain/entities.js";
import type {
  UserStatus,
  UserRole,
  EmailVerificationPurpose,
} from "../../domain/enums.js";
import type { Queryable } from "../mysql/db.js";
import type {
  AdminUserRow,
  AdminUserFilter,
} from "./admin.js";

/** 仓储接口 · user（自 interfaces.ts 按聚合拆分，纯类型移动）。 */

export interface IUserRepo {
  findById(id: number): Promise<User | undefined>;
  /** 在事务内锁定用户行（`SELECT ... FOR UPDATE`），作为该用户设备配额/会话操作的序列化点。 */
  lockById(exec: Queryable, id: number): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  /**
   * 事务内按 id 读用户（不加锁）。调用方已在事务中时**必须**用此变体而非
   * `findById`：在持有事务连接时再向池申请连接会耗尽 connectionLimit，
   * 而 mysql2 无获取超时，进程将永久死锁。
   */
  findByIdInTx(exec: Queryable, id: number): Promise<User | undefined>;
  /** 事务内按 email 读用户（不加锁）。同上，事务中不得走连接池。 */
  findByEmailInTx(exec: Queryable, email: string): Promise<User | undefined>;
  /** 创建用户（status 固定 active）。email 应由调用方规范化小写。 */
  create(email: string, passwordHash: string, displayName?: string): Promise<User>;
  updateLastLogin(id: number, time: Date): Promise<void>;
  /** 改密（在改密事务内执行，与撤销会话同事务）。 */
  updatePassword(exec: Queryable, id: number, passwordHash: string): Promise<void>;
  updateStatus(id: number, status: UserStatus): Promise<void>;
  /** 事务内更新用户状态（禁用/启用，与撤销会话同事务）。 */
  updateStatusInTx(exec: Queryable, id: number, status: UserStatus): Promise<void>;
  /** 置平台角色（仅 DEVBELT_DB_PLATFORM_ADMIN_EMAILS 受控引导任务写入）。 */
  setRole(id: number, role: UserRole): Promise<void>;
  /** 平台用户列表（filter + keyset cursor，DESC by id）。 */
  listUsers(input: AdminUserFilter): Promise<AdminUserRow[]>;
  /** 平台用户命中计数（导出/校验上限用）。 */
  countUsers(input: Omit<AdminUserFilter, 'cursor' | 'limit'>): Promise<number>;
  /** 置 email_verified_time（与 token 消费同事务）。 */
  markEmailVerified(exec: Queryable, id: number, time: Date): Promise<void>;
  /** 会话版本 +1（改密/禁用时，用于使存量 access token 立即失效）。事务内执行。 */
  incrementSessionVersion(exec: Queryable, id: number): Promise<void>;
  /** 更新显示名（PATCH /api/console/me，§4.4 校验在 service 层）。单列更新，无需事务。 */
  updateDisplayName(id: number, displayName: string): Promise<void>;
  /** 事务内更新显示名（幂等回执下审计+业务同事务）。 */
  updateDisplayNameInTx(exec: Queryable, id: number, displayName: string): Promise<void>;
}

export interface IEmailVerificationTokenRepo {
  create(exec: Queryable, input: {
    userId: number;
    email: string;
    purpose: EmailVerificationPurpose;
    tokenHash: string;
    expiresTime: Date;
  }): Promise<EmailVerificationToken>;
  /** 按 hash 查未消费 token（只读）。 */
  findByHash(tokenHash: string): Promise<EmailVerificationToken | undefined>;
  /** 在事务内锁定 token 行（confirmEmail 与 markEmailVerified 同事务）。 */
  findByHashForUpdate(exec: Queryable, tokenHash: string): Promise<EmailVerificationToken | undefined>;
  /** 事务内按 id 锁定 token 行（mail-flow 消费按 target_record_id 定位而非 raw token hash）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<EmailVerificationToken | undefined>;
  /** 事务内按 id 读 token（不加锁），仅用于锁序预读 userId，避免与旧 confirm 路径成死锁环。 */
  findByIdInTx(exec: Queryable, id: number): Promise<EmailVerificationToken | undefined>;
  /** 原子消费：AND consumed_time IS NULL，返回是否由本次调用完成。事务内执行。 */
  consume(exec: Queryable, id: number, now: Date): Promise<boolean>;
  /** 作废某用户 +(email,purpose) 既有的未消费 token（重发前调用）。事务内执行。 */
  invalidate(exec: Queryable, userId: number, email: string, purpose: EmailVerificationPurpose, now: Date): Promise<void>;
  /** 删除已消费或已过期且超出保留期的 token 行。返回删除行数。 */
  prune(before: Date, limit: number): Promise<number>;
}

export interface IPersonalSubscriptionRepo {
  findByUserId(userId: number): Promise<PersonalSubscription | undefined>;
  /** 事务内按 user_id 读取，用于锁内配额计量。 */
  findByUserIdInTx(exec: Queryable, userId: number): Promise<PersonalSubscription | undefined>;
  /** 事务内锁定订阅行（订阅调整序列化点，§6.2）。 */
  findByUserIdForUpdate(exec: Queryable, userId: number): Promise<PersonalSubscription | undefined>;
  create(input: {
    userId: number;
    planId: number;
    status: PersonalSubscription['status'];
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<PersonalSubscription>;
  /** 乐观更新（§6.2）：`WHERE id=? AND version=expectedVersion`，version+1；返回是否命中。 */
  update(exec: Queryable, input: {
    id: number;
    planId: number;
    status: PersonalSubscription['status'];
    periodEndTime: Date | null;
    expectedVersion: number;
  }): Promise<boolean>;
}

export interface IDeviceRepo {
  /** 在事务（exec）内按 (user_id, device_key) upsert；不存在创建 active，active 更新元数据，revoked 复活。 */
  upsert(exec: Queryable, device: Omit<Device, 'id' | 'createTime' | 'updateTime'>): Promise<Device>;
  /** 按 (user_id, device_key) 查设备。配额相关读取必须在事务（exec）内执行。 */
  findByUserAndKey(exec: Queryable, userId: number, deviceKey: string): Promise<Device | undefined>;
  /** 在事务内锁定设备行（`SELECT ... FOR UPDATE`），摘撤销设备时保证与 session 撤销同事务。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<Device | undefined>;
  listByUser(userId: number): Promise<Device[]>;
  /** active 设备数（占用配额的计量）。必须在事务（exec）内执行，配合用户行锁防并发绕过。 */
  countActive(exec: Queryable, userId: number): Promise<number>;
  /** 已撤销设备（status=revoked）。 */
  revoke(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 仅更新 last_used_time（refresh 时刷新活跃，不改变 status、不创建、不复活）。 */
  touch(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 查某用户 active 的指定 platform 设备（Web Console 单槽位）。事务内执行。 */
  findActiveByUserAndPlatform(exec: Queryable, userId: number, platform: string): Promise<Device | undefined>;
}

export interface IRefreshTokenRepo {
  create(exec: Queryable, input: {
    userId: number;
    deviceId: number | null;
    tokenHash: string;
    familyId: string;
    expiresTime: Date;
  }): Promise<RefreshToken>;
  findByHash(tokenHash: string): Promise<RefreshToken | undefined>;
  /** 在事务内锁定 token 行（`SELECT ... FOR UPDATE`），refresh 轮换的序列化点。 */
  findByHashForUpdate(exec: Queryable, tokenHash: string): Promise<RefreshToken | undefined>;
  findById(id: number): Promise<RefreshToken | undefined>;
  /** 原子消费：AND revoked_time IS NULL，返回是否由本次调用完成。事务内执行。 */
  consume(exec: Queryable, id: number, now: Date): Promise<boolean>;
  /** 撤销某 family 全部未撤销 token（refresh 复用检测触发）。 */
  revokeFamily(exec: Queryable, familyId: string, now: Date): Promise<void>;
  /** 撤销某设备全部 token（设备撤销时调用）。 */
  revokeByDevice(exec: Queryable, deviceId: number, now: Date): Promise<void>;
  /** 撤销某用户全部 token（改密/禁用时调用）。 */
  revokeAllForUser(exec: Queryable, userId: number, now: Date): Promise<void>;
  /** 该 family 是否仍有活跃（未撤销、未过期）token（会话存活判定，供 requireSession 每请求核验）。 */
  hasActiveToken(familyId: string): Promise<boolean>;
  /**
   * 删除已终结且超出保留期的 token 行（`expires_time < before OR revoked_time < before`）。
   * 轮换每次刷新都插新行、旧行仅置 revoked_time，不清理会无界增长
   * （access 15min 过期即轮换 ⇒ 单活跃用户约 2900 行/月）。
   * 返回删除行数，便于清理任务分批推进。
   */
  prune(before: Date, limit: number): Promise<number>;
}

export interface IRateLimitRepo {
  /** 固定窗口原子递增（唯一键 bucket_key+window_start_time），返回递增后的计数。 */
  increment(bucketKey: string, windowStartTime: Date): Promise<number>;
  /** 同一事务内递增（与幂等回执同连接，限流与业务写、回执同滚）。 */
  incrementInTx(exec: Queryable, bucketKey: string, windowStartTime: Date): Promise<number>;
  /** 只读当前窗口计数（不存在则 0），供「失败才计数」的预检。 */
  peek(bucketKey: string, windowStartTime: Date): Promise<number>;
  /** 清理早于该时间的过期桶。 */
  prune(before: Date): Promise<void>;
}

export interface RegistrationAccountInput {
  email: string;
  passwordHash: string;
  displayName?: string;
  verificationTokenHash: string;
  verificationExpiresTime: Date;
}

export interface RegistrationResult {
  userId: number;
}

export interface IRegistrationRepo {
  createAccount(input: RegistrationAccountInput): Promise<RegistrationResult>;
}
