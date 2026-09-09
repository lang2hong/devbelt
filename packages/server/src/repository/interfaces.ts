import type {
  User,
  EmailVerificationToken,
  PersonalPlan,
  PersonalSubscription,
  Device,
  RefreshToken,
  Organization,
  OrganizationPlan,
  OrganizationSubscription,
  OrganizationMembership,
  OrganizationInvitation,
  Folder,
  Resource,
  PersonalSyncState,
  PersonalConnectionMeta,
  SyncMutation,
  SyncResetToken,
  SyncResetHandoff,
  MailFlow,
  AuditEvent,
  IdempotencyReceipt,
} from '../domain/entities.js';
import type {
  UserStatus,
  UserRole,
  EmailVerificationPurpose,
  OrganizationRole,
  OrganizationMembershipStatus,
  OrganizationSubscriptionStatus,
  OrganizationStatus,
  ResourceType,
  SyncAction,
  MailFlowType,
} from '../domain/enums.js';
import type { Queryable } from './mysql/db.js';

/**
 * 数据访问层接口（Repository 模式）。
 *
 * 接口与实现分离：domain/service 仅依赖接口，不依赖具体 DB 驱动。
 * 当前唯一实现为 mysql/。带 `exec` 参数的方法在**调用方事务**（TxRunner 提供的
 * Queryable）上执行，用于跨表原子性；不带 `exec` 的为普通只读 / 独立写。
 */

/** 平台用户列表行（join 订阅取 planCode + 设备数，§2.3/§6 运营元数据）。 */
export interface AdminUserRow {
  userId: number;
  email: string;
  emailVerifiedTime: Date | null;
  displayName?: string;
  status: UserStatus;
  role: UserRole;
  lastLoginTime: Date | null;
  createTime: Date;
  planCode: string | null;
  deviceCount: number;
  /** 个人订阅当前版本（供乐观订阅调整 expectedVersion）。 */
  subscriptionVersion: number | null;
  periodEndTime: Date | null;
}

/** 平台用户列表过滤（cursor 为上一页最后一条 userId，keyset DESC）。 */
export interface AdminUserFilter {
  emailExact?: string;
  userId?: number;
  status?: UserStatus;
  planCode?: string;
  createdFrom?: Date;
  createdTo?: Date;
  cursor?: number;
  limit: number;
}

/** 平台组织列表行（join 订阅取 planCode/seatLimit + 成员/邀请计数）。 */
export interface AdminOrgRow {
  organizationId: number;
  name: string;
  status: OrganizationStatus;
  planCode: string | null;
  seatLimit: number | null;
  activeMemberCount: number;
  invitedCount: number;
  createTime: Date;
  /** 组织订阅当前版本（供乐观订阅调整 expectedVersion）。 */
  subscriptionVersion: number | null;
  periodEndTime: Date | null;
}

/** 平台组织列表过滤。 */
export interface AdminOrgFilter {
  namePrefix?: string;
  status?: OrganizationStatus;
  planCode?: string;
  cursor?: number;
  limit: number;
}

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
  /** 置平台角色（仅 PLATFORM_ADMIN_EMAILS 受控引导任务写入）。 */
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
  /** 作废某用户 +(email,purpose) 既有的未消费 token（重发/重新邀请前调用）。事务内执行。 */
  invalidate(exec: Queryable, userId: number, email: string, purpose: EmailVerificationPurpose, now: Date): Promise<void>;
  /** 删除已消费或已过期且超出保留期的 token 行。返回删除行数。 */
  prune(before: Date, limit: number): Promise<number>;
}

export interface IPersonalPlanRepo {
  findByCode(code: string): Promise<PersonalPlan | undefined>;
  findById(id: number): Promise<PersonalPlan | undefined>;
  /** 事务内按 code 读（订阅调整在回执事务内解析套餐，§6.2）。 */
  findByCodeInTx(exec: Queryable, code: string): Promise<PersonalPlan | undefined>;
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
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<PersonalSubscription>;
  /** 乐观更新（§6.2）：`WHERE id=? AND version=expectedVersion`，version+1；返回是否命中。 */
  update(exec: Queryable, input: {
    id: number;
    planId: number;
    status: PersonalSubscription['status'];
    entitlementSnapshot: Record<string, unknown>;
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
    replacedByTokenId: number | null;
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

/**
 * 分桶键约定（服务端生成，绝不包含密码/token）：
 * - `login:email:<normalized>`  — 登录按 email 限流
 * - `login:ip:<ip>`             — 登录按来源 IP 限流
 * - `register:ip:<ip>`          — 注册按来源 IP 限流
 * - `verify:email:<normalized>` — 邮箱验证重发按 email 限流（匿名）
 * - `verify:ip:<ip>`            — 邮箱验证重发按来源 IP 限流（匿名）
 * - `org:create:user:<userId>`  — 组织创建按用户限流（已认证，不按 IP）
 */
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

/** 注册账号入参（邮箱验证 token 的 hash/过期由 service 提前算好）。 */
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

/**
 * 注册账号仓储：单事务原子创建 user + Free 订阅（含 entitlement snapshot）+ 邮箱验证 token。
 *
 * 三张表任一失败整体回滚，避免「有 user 无订阅 / 无验证 token」的半套状态。
 * Free 套餐 id 在事务内按 code 查询；缺失即报错（migration 002 必须先播种）。
 */
export interface IRegistrationRepo {
  createAccount(input: RegistrationAccountInput): Promise<RegistrationResult>;
}

// ── 组织域 ──

export interface IOrganizationPlanRepo {
  findByCode(code: string): Promise<OrganizationPlan | undefined>;
  findById(id: number): Promise<OrganizationPlan | undefined>;
  /** 在事务内锁定 plan 行（创建组织时防 plan 变更）。 */
  findByCodeForUpdate(exec: Queryable, code: string): Promise<OrganizationPlan | undefined>;
}

export interface IOrganizationRepo {
  findById(id: number): Promise<Organization | undefined>;
  /** 在事务内锁定组织行（成员变更/关闭的序列化点）。 */
  lockById(exec: Queryable, id: number): Promise<Organization | undefined>;
  create(exec: Queryable, input: { name: string }): Promise<Organization>;
  updateName(exec: Queryable, id: number, name: string): Promise<void>;
  close(exec: Queryable, id: number, closedTime: Date): Promise<void>;
  /** 平台组织列表（filter + keyset cursor，DESC by id），join 订阅/成员/邀请计数。 */
  listForAdmin(input: AdminOrgFilter): Promise<AdminOrgRow[]>;
  /** 平台组织命中计数。 */
  countForAdmin(input: Omit<AdminOrgFilter, 'cursor' | 'limit'>): Promise<number>;
}

export interface IOrganizationSubscriptionRepo {
  findByOrganizationId(organizationId: number): Promise<OrganizationSubscription | undefined>;
  /** 在事务内锁定订阅行（创建/接受/撤销邀请时取 seat_limit，§6.2）。 */
  findByOrganizationIdForUpdate(exec: Queryable, organizationId: number): Promise<OrganizationSubscription | undefined>;
  create(exec: Queryable, input: {
    organizationId: number;
    planId: number;
    seatLimit: number;
    status: OrganizationSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<OrganizationSubscription>;
  /** 乐观更新（§6.2）：`WHERE id=? AND version=expectedVersion`，version+1；返回是否命中。 */
  update(exec: Queryable, input: {
    id: number;
    planId: number;
    seatLimit: number;
    status: OrganizationSubscriptionStatus;
    entitlementSnapshot: Record<string, unknown>;
    periodEndTime: Date | null;
    expectedVersion: number;
  }): Promise<boolean>;
}

/** 成员目录项（join users 取 displayName；不返回 email，§2 第 4 条）。 */
export interface MemberDto {
  membershipId: number;
  userId: number;
  displayName?: string;
  role: OrganizationRole;
  status: OrganizationMembershipStatus;
  joinedTime: Date | null;
}

/** 列组织用的组织摘要（join organizations 得到名称/状态与调用者角色）。 */
export interface OrganizationSummary {
  organizationId: number;
  name: string;
  status: string;
  closedTime: Date | null;
  role: OrganizationRole;
}

export interface IMembershipRepo {
  create(exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    status: OrganizationMembershipStatus;
    invitedByUserId: number | null;
    joinedTime: Date | null;
    removedTime: Date | null;
  }): Promise<OrganizationMembership>;
  /** 成员目录（active + invited，不含 removed），join users 取 displayName。 */
  listByOrganization(organizationId: number): Promise<MemberDto[]>;
  /** 某用户的 active membership（含组织 id，用于列组织）。 */
  listActiveByUser(userId: number): Promise<OrganizationMembership[]>;
  /** 某用户 active membership 且组织 active 的摘要（单条 JOIN organizations，供列组织）。 */
  listActiveByUserWithOrg(userId: number): Promise<OrganizationSummary[]>;
  /** 普通读（授权中间件用，非锁）。 */
  findByOrgAndUser(organizationId: number, userId: number): Promise<OrganizationMembership | undefined>;
  /** 事务内锁定 membership 行（角色/移除/退出）。 */
  findByOrgAndUserForUpdate(exec: Queryable, organizationId: number, userId: number): Promise<OrganizationMembership | undefined>;
  /** 事务内锁定 membership 行（按 id）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<OrganizationMembership | undefined>;
  updateRole(exec: Queryable, id: number, role: OrganizationRole): Promise<void>;
  /** 置 status=removed + removed_time（移除/退出时）。 */
  remove(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 关闭组织时把该组织全部 invited membership 置 removed。 */
  removeInvitedByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void>;
  /**
   * 写入/复用一个 invited membership（创建邀请时用）：不存在则建，已存在（removed /
   * invited）则改回 invited 并覆盖角色，写 invited_by、清 joined/removed。按
   * (organization_id,user_id) 唯一键 upsert。
   */
  upsertInvited(exec: Queryable, input: {
    organizationId: number;
    userId: number;
    role: OrganizationRole;
    invitedByUserId: number;
  }): Promise<OrganizationMembership>;
  /** 置 status=active + joined_time、清 removed_time（接受邀请时）。 */
  activate(exec: Queryable, id: number, now: Date): Promise<void>;
  /** active 成员数（容量计量，不含 invited）。 */
  countActive(exec: Queryable, organizationId: number): Promise<number>;
  /** 有效 invited 成员数（join invitations，排除过期/撤销/已接受；容量计量）。 */
  countValidInvited(exec: Queryable, organizationId: number, now: Date): Promise<number>;
  /** active admin 数（最后 active admin 保护）。 */
  countActiveAdmins(exec: Queryable, organizationId: number): Promise<number>;
}

// ── 组织邀请 ──

/** 有效邀请目录项（join membership 取角色；不含 token/hash，§2 第 4 条）。 */
export interface InvitationDto {
  invitationId: number;
  email: string;
  role: OrganizationRole;
  expiresTime: Date;
  invitedTime: Date;
}

export interface IOrganizationInvitationRepo {
  create(exec: Queryable, input: {
    organizationId: number;
    membershipId: number;
    email: string;
    tokenHash: string;
    expiresTime: Date;
  }): Promise<OrganizationInvitation>;
  /** 按 token hash 只读查找（accept 预检，不回锁，锁定交给后续步骤）。 */
  findByTokenHash(tokenHash: string): Promise<OrganizationInvitation | undefined>;
  /** 按 id 只读查找（revoke 预检，不回锁）。 */
  findById(id: number): Promise<OrganizationInvitation | undefined>;
  /** 事务内按 id 锁定 invitation 行（accept/revoke 的序列化点）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<OrganizationInvitation | undefined>;
  /** 事务内按 token hash 锁定（唯一键）。 */
  findByTokenHashForUpdate(exec: Queryable, tokenHash: string): Promise<OrganizationInvitation | undefined>;
  /** 作废某 membership 既有的未终结 invitation（重新邀请前调用，保证同时最多一个有效 token）。 */
  revokeByMembership(exec: Queryable, membershipId: number, now: Date): Promise<void>;
  /** 撤销某组织全部未终结 invitation（关闭组织时调用）。 */
  revokeByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void>;
  /** 标记接受（写 accepted_time）。 */
  markAccepted(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 标记撤销（写 revoked_time）。 */
  markRevoked(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 列某组织有效邀请（未 accepted/revoked 且未过期），join membership 取角色。 */
  listActiveByOrganization(organizationId: number, now: Date): Promise<InvitationDto[]>;
  /** 该 membership 当前是否有有效（未过期/未撤销/未接受）邀请。 */
  hasValidInvitation(exec: Queryable, membershipId: number, now: Date): Promise<boolean>;
  /** 列出有「已过期且未终结」邀请的组织 id（过期清理的候选，只读）。 */
  findExpiredOrganizationIds(now: Date): Promise<number[]>;
  /**
   * 把某组织内「过期（expires_time<=now 且未 accepted/revoked）」的邀请置 revoked、
   * 对应 membership 置 removed。必须在调用方事务内（已锁组织+订阅）执行。幂等。
   */
  expireByOrganization(exec: Queryable, organizationId: number, now: Date): Promise<void>;
}

// ── 组织资源 ──

/** 目录 DTO（无作者字段，id 在 route 层转 string）。 */
export interface FolderDto {
  folderId: number;
  name: string;
  parentId: number | null;
}

/** 资源列表项 DTO（不含 content，§6.4 载荷）。 */
export interface ResourceSummaryDto {
  resourceId: number;
  resourceType: ResourceType;
  name: string;
  folderId: number | null;
  version: number;
  createdByMembershipId: number;
  updatedByMembershipId: number | null;
}

export interface IFolderRepo {
  create(exec: Queryable, input: { organizationId: number; parentId: number | null; name: string }): Promise<Folder>;
  /** 事务内按 (id, organization_id) 锁定目录行（org 作用域）。 */
  findByIdForUpdate(exec: Queryable, organizationId: number, id: number): Promise<Folder | undefined>;
  /** 组织内全部未删除目录（含 parent_id）。 */
  listActive(organizationId: number): Promise<Folder[]>;
  /** 未删除子目录数（删除非空判定）。 */
  countActiveChildren(exec: Queryable, organizationId: number, parentId: number): Promise<number>;
  /** 目录下未删除资源数（删除非空判定）。 */
  countActiveResources(exec: Queryable, organizationId: number, folderId: number): Promise<number>;
  updateName(exec: Queryable, id: number, name: string, organizationId: number): Promise<void>;
  updateParent(exec: Queryable, id: number, parentId: number | null, organizationId: number): Promise<void>;
  /** 软删：`WHERE id AND organization_id AND delete_time IS NULL`。 */
  softDelete(exec: Queryable, id: number, organizationId: number, now: Date): Promise<void>;
  /** 该目录在组织内的全部后代目录 id（含自身；环比检测）。 */
  collectDescendantIds(exec: Queryable, organizationId: number, folderId: number): Promise<number[]>;
}

export interface IResourceRepo {
  create(exec: Queryable, input: {
    organizationId: number;
    folderId: number | null;
    resourceType: ResourceType;
    name: string;
    content: Record<string, unknown>;
    version: number;
    createdByMembershipId: number;
  }): Promise<Resource>;
  /** 按 (id, organization_id) 只读查（org 作用域）。 */
  findById(organizationId: number, id: number): Promise<Resource | undefined>;
  /** 事务内按 (id, organization_id) 锁定资源行（org 作用域）。 */
  findByIdForUpdate(exec: Queryable, organizationId: number, id: number): Promise<Resource | undefined>;
  /** 组织内全部未删除资源（不含 content）。 */
  listActiveByOrganization(organizationId: number): Promise<ResourceSummaryDto[]>;
  /** 锁内读回未删除资源 content（app 侧按 canonical JSON 计量，§6.2）。 */
  listActiveContent(exec: Queryable, organizationId: number): Promise<Record<string, unknown>[]>;
  /** 乐观锁更新（§6.2）：`WHERE id AND organization_id AND version=? AND delete_time IS NULL`；返回受影响的 skipper。 */
  update(exec: Queryable, input: {
    id: number;
    organizationId: number;
    name: string;
    folderId: number | null;
    content: Record<string, unknown>;
    baseVersion: number;
    updatedByMembershipId: number;
  }): Promise<boolean>;
  /** 软删：`WHERE id AND organization_id AND delete_time IS NULL`，写 updated_by。 */
  softDelete(exec: Queryable, id: number, organizationId: number, now: Date, deletedByMembershipId: number): Promise<void>;
}

// ── 个人 E2E 同步（§7 专项）──

export interface ISyncStateRepo {
  /** 只读当前 active state（无锁）。 */
  findByUserId(userId: number): Promise<PersonalSyncState | undefined>;
  /** 事务内锁定 state 行（FOR UPDATE），所有 sync mutation 的序列化点。 */
  lockByUserId(exec: Queryable, userId: number): Promise<PersonalSyncState | undefined>;
  /** 首次建态（仅当无行）；已存在返回 false。init 用。 */
  create(exec: Queryable, state: Omit<PersonalSyncState, 'createTime' | 'updateTime'>): Promise<boolean>;
  /** 覆盖 state 行（change-key/recover/destroy/reset）：`WHERE user_id AND state_version=expectedStateVersion`。 */
  update(exec: Queryable, userId: number, expectedStateVersion: string, state: Omit<PersonalSyncState, 'createTime' | 'updateTime'>): Promise<boolean>;
}

export interface ISyncRecordRepo {
  create(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    recordId: Buffer;
    cipherSuite: PersonalConnectionMeta['cipherSuite'];
    formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
    version: string;
    changeSequence: string;
  }): Promise<PersonalConnectionMeta>;
  /** 事务内按 (user_id, key_epoch, record_id) 锁定 record（FOR UPDATE）。 */
  findForUpdate(exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer): Promise<PersonalConnectionMeta | undefined>;
  /** 乐观锁更新（`WHERE version=baseVersion AND delete_time IS NULL`）并写新 version/change_sequence。 */
  update(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    recordId: Buffer;
    baseVersion: string;
    cipherSuite: PersonalConnectionMeta['cipherSuite'];
    formatVersion: PersonalConnectionMeta['formatVersion'];
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
    newVersion: string;
    changeSequence: string;
  }): Promise<boolean>;
  /** 软删 tombstone：清空 ciphertext/tag、写 delete_time 与新 version/change_sequence。 */
  softDelete(exec: Queryable, userId: number, keyEpoch: string, recordId: Buffer, baseVersion: string, newVersion: string, changeSequence: string, now: Date): Promise<boolean>;
  /** feed：active epoch 内 `change_sequence > after AND <= snapshotSequence`，含 tombstone，按 change_sequence 升序。 */
  listByFeed(exec: Queryable, userId: number, keyEpoch: string, after: string, snapshotSequence: string, limit: number): Promise<PersonalConnectionMeta[]>;
  /** active record 数 + 密文字节（配额计量：ciphertext+tag+nonce 长度，§4.2）。锁内执行。 */
  countActive(exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number }>;
  /** 同步概览聚合：active epoch 的记录数、密文字节、最近活动时间（无 record 时 null）。 */
  overview(exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number; lastActivityTime: Date | null }>;
  /** 列出该 epoch 全部未删 record（destroy/reset 逐个 tombstone 用，持锁内调用）。 */
  listActiveByEpoch(exec: Queryable, userId: number, keyEpoch: string): Promise<PersonalConnectionMeta[]>;
}

export interface ISyncNonceRepo {
  /** 插入 nonce；唯一键冲突返回 false（对应 SYNC_NONCE_REUSED），成功 true。 */
  insert(exec: Queryable, userId: number, keyEpoch: string, nonce: Buffer): Promise<boolean>;
}

export interface ISyncMutationRepo {
  /** 幂等查：返回该 mutationId 的 receipt（若有）。 */
  findByMutationId(exec: Queryable, userId: number, keyEpoch: string, mutationId: Buffer): Promise<SyncMutation | undefined>;
  /** UPSERT（by PK）一份已应用 mutation 的结果。 */
  record(exec: Queryable, input: {
    userId: number;
    keyEpoch: string;
    mutationId: Buffer;
    requestDigest: Buffer;
    action: SyncAction;
    resultVersion: string | null;
    resultChangeSequence: string | null;
    status: SyncMutation['status'];
    expiresTime: Date;
  }): Promise<void>;
  /**
   * 删除已过 expires_time 的 receipt。该列本就是为清理而设，但此前无人清 ——
   * 每次 record mutation 都插一行，不清理即无界增长。返回删除行数。
   * 本仓储无状态（不持连接池），故 exec 由调用方传入。
   */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}

export interface ISyncResetTokenRepo {
  create(exec: Queryable, input: { userId: number; tokenHash: Buffer; expiresTime: Date }): Promise<SyncResetToken>;
  /** 作废该用户全部未消费、未撤销 token（重新发起 challenge 前）。 */
  revokePendingByUser(exec: Queryable, userId: number, now: Date): Promise<void>;
  /** 事务内按 hash 锁定可用 token（未消费/未撤销/未过期）。 */
  findUsableForUpdate(exec: Queryable, tokenHash: Buffer): Promise<SyncResetToken | undefined>;
  /** 只读按 token_hash 查找（mail-flow 认领解析 target_record_id 用）。 */
  findByHash(tokenHash: Buffer): Promise<SyncResetToken | undefined>;
  /** 事务内按 id 锁定 reset token 行（handoff 消费锁序的第一把锁）。 */
  findByIdForUpdate(exec: Queryable, id: number): Promise<SyncResetToken | undefined>;
  /** 原子消费（`WHERE consumed_time IS NULL AND revoked_time IS NULL`）。 */
  consume(exec: Queryable, id: number, now: Date): Promise<boolean>;
  /** 删除已消费/已撤销/已过期且超出保留期的 token 行。返回删除行数。 */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}

/** sync-reset handoff（浏览器签发、扩展消费的一次性交接 ticket；仅存 SHA-256）。 */
export interface ISyncResetHandoffRepo {
  create(exec: Queryable, input: { userId: number; resetTokenId: number; ticketHash: Buffer; expiresTime: Date }): Promise<SyncResetHandoff>;
  /** 只读按 ticket_hash 查找（消费预检走锁前）。 */
  findByTicketHash(ticketHash: Buffer): Promise<SyncResetHandoff | undefined>;
  /** 事务内按 ticket_hash 锁定（唯一键）。 */
  findByTicketHashForUpdate(exec: Queryable, ticketHash: Buffer): Promise<SyncResetHandoff | undefined>;
  /** 撤销某 reset token 下全部 issued/processing 未终结 handoff（签发新 handoff 前）。 */
  revokePendingByResetToken(exec: Queryable, resetTokenId: number, now: Date): Promise<void>;
  /** 置 processing + 写 request_digest（最终 reset 首次进入）。 */
  markProcessing(exec: Queryable, id: number, requestDigest: Buffer, now: Date): Promise<void>;
  /** 置 completed + 写结果收据（result_state_dto_json + 冗余计数字段）。 */
  markCompleted(exec: Queryable, id: number, now: Date, result: { stateDtoJson: string; keyEpoch: string; stateVersion: string; changeSequence: string }): Promise<void>;
  /** processing 超时（60s，崩溃恢复）回退 issued。 */
  rollbackProcessing(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 过期 issued/processing → expired（清理任务，返回受影响行数）。 */
  expire(exec: Queryable, now: Date, limit: number): Promise<number>;
  /** 删除 completed/revoked/expired 且超出保留期的行。返回删除行数。 */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}

// ── 一次性邮件链接（mail-flow）与审计 ──

export interface IMailFlowRepo {
  create(input: {
    type: MailFlowType;
    targetTokenHash: Buffer;
    targetRecordId: number | null;
    userId: number | null;
    nonceHash: Buffer;
    expiresTime: Date;
  }): Promise<MailFlow>;
  /** 按 nonce hash 只读查找。 */
  findByNonceHash(nonceHash: Buffer): Promise<MailFlow | undefined>;
  /** 事务内按 nonce hash 锁定 mail_flow 行（消费的序列化点）。 */
  findByNonceHashForUpdate(exec: Queryable, nonceHash: Buffer): Promise<MailFlow | undefined>;
  /** 绑定登录用户到邮件流（`user_id`）；仅 issued 且未绑定/同用户时生效。事务内执行。 */
  bindUser(exec: Queryable, id: number, userId: number): Promise<void>;
  /** 标记消费（写 consumed_time）。事务内执行。 */
  markConsumed(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 删除已过期或已消费且超出保留期的 flow 行。返回删除行数。 */
  prune(before: Date, limit: number): Promise<number>;
}

/** 审计事件写入（append-only；只 INSERT，不 UPDATE/DELETE）。 */
export interface IAuditRepo {
  insert(event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent>;
  /** 事务内写入（幂等回执下审计与业务写同事务、重放不重复审计）。 */
  insertInTx(exec: Queryable, event: Omit<AuditEvent, 'id' | 'createTime'>): Promise<AuditEvent>;
  /** 平台审计查询（filter 有序，cursor 为上一页最后一条 id，DESC）。 */
  search(input: AuditFilter): Promise<AuditEvent[]>;
  /** 平台审计命中计数（导出上限校验）。 */
  count(input: Omit<AuditFilter, 'cursor' | 'limit'>): Promise<number>;
  /** 事务内查询（导出幂等回执下读取与审计写同事务）。 */
  searchInTx(exec: Queryable, input: AuditFilter): Promise<AuditEvent[]>;
  /** 事务内计数（导出上限校验）。 */
  countInTx(exec: Queryable, input: Omit<AuditFilter, 'cursor' | 'limit'>): Promise<number>;
}

/** 平台审计查询过滤（§9）。时间跨度由 service 限制 ≤31 天。 */
export interface AuditFilter {
  fromTime?: Date;
  toTime?: Date;
  actorUserId?: number;
  eventType?: string;
  targetType?: string;
  organizationId?: number;
  cursor?: number;
  limit: number;
}

/** 幂等回执仓储（P3 §6.1）。 */
export interface IIdempotencyReceiptRepo {
  /** 事务内插入 processing 回执（唯一键冲突抛 ER_DUP_ENTRY，由服务层捕获转重放/冲突）。 */
  createProcessing(exec: Queryable, input: {
    actorUserId: number;
    sessionId: string;
    method: string;
    normalizedPath: string;
    idempotencyKey: string;
    requestDigest: Buffer;
    expiresTime: Date;
  }): Promise<IdempotencyReceipt>;
  /** 只读查回执（预检，连接池）。 */
  findByKey(actorUserId: number, sessionId: string, method: string, normalizedPath: string, idempotencyKey: string): Promise<IdempotencyReceipt | undefined>;
  /** 事务内置 completed：http_status + 规范 JSON 响应体。 */
  complete(exec: Queryable, id: number, httpStatus: number, responseBody: string): Promise<void>;
  /** 删除已过期（expires_time < before）的回执行。返回删除行数。 */
  prune(exec: Queryable, before: Date, limit: number): Promise<number>;
}
