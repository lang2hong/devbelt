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
} from '../domain/entities.js';
import type {
  UserStatus,
  EmailVerificationPurpose,
  OrganizationRole,
  OrganizationMembershipStatus,
  OrganizationSubscriptionStatus,
  ResourceType,
  SyncAction,
} from '../domain/enums.js';
import type { Queryable } from './mysql/db.js';

/**
 * V3 Phase 1 数据访问层接口（Repository 模式）。
 *
 * 接口与实现分离：domain/service 仅依赖接口，不依赖具体 DB 驱动。
 * 当前唯一实现为 mysql/。带 `exec` 参数的方法在**调用方事务**（TxRunner 提供的
 * Queryable）上执行，用于跨表原子性；不带 `exec` 的为普通只读 / 独立写。
 */

export interface IUserRepo {
  findById(id: number): Promise<User | undefined>;
  /** 在事务内锁定用户行（`SELECT ... FOR UPDATE`），作为该用户设备配额/会话操作的序列化点。 */
  lockById(exec: Queryable, id: number): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  /** 创建用户（status 固定 active）。email 应由调用方规范化小写。 */
  create(email: string, passwordHash: string, displayName?: string): Promise<User>;
  updateLastLogin(id: number, time: Date): Promise<void>;
  /** 改密（在改密事务内执行，与撤销会话同事务）。 */
  updatePassword(exec: Queryable, id: number, passwordHash: string): Promise<void>;
  updateStatus(id: number, status: UserStatus): Promise<void>;
  /** 置 email_verified_time（与 token 消费同事务）。 */
  markEmailVerified(exec: Queryable, id: number, time: Date): Promise<void>;
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
  /** 原子消费：AND consumed_time IS NULL，返回是否由本次调用完成。事务内执行。 */
  consume(exec: Queryable, id: number, now: Date): Promise<boolean>;
  /** 作废某用户 +(email,purpose) 既有的未消费 token（重发/重新邀请前调用）。事务内执行。 */
  invalidate(exec: Queryable, userId: number, email: string, purpose: EmailVerificationPurpose, now: Date): Promise<void>;
}

export interface IPersonalPlanRepo {
  findByCode(code: string): Promise<PersonalPlan | undefined>;
  findById(id: number): Promise<PersonalPlan | undefined>;
}

export interface IPersonalSubscriptionRepo {
  findByUserId(userId: number): Promise<PersonalSubscription | undefined>;
  create(input: {
    userId: number;
    planId: number;
    status: PersonalSubscription['status'];
    entitlementSnapshot: Record<string, unknown>;
    periodStartTime: Date;
    periodEndTime: Date | null;
  }): Promise<PersonalSubscription>;
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
  /** 撤销设备（status=revoked）。 */
  revoke(exec: Queryable, id: number, now: Date): Promise<void>;
  /** 仅更新 last_used_time（refresh 时刷新活跃，不改变 status、不创建、不复活）。 */
  touch(exec: Queryable, id: number, now: Date): Promise<void>;
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

// ── 组织域（切片 2）──

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
}

export interface IOrganizationSubscriptionRepo {
  findByOrganizationId(organizationId: number): Promise<OrganizationSubscription | undefined>;
  /** 在事务内锁定订阅行（创建/接受/撤销邀请时取 seat_limit，§4.3）。 */
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
}

/** 成员目录项（join users 取 displayName；不返回 email，§5.1）。 */
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
  /** 关闭组织时把该组织全部 invited membership 置 removed（invitations 行撤销属切片 3）。 */
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

// ── 组织邀请（切片 3）──

/** 有效邀请目录项（join membership 取角色；不含 token/hash，§5.1）。 */
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

// ── 组织资源（切片 4）──

/** 目录 DTO（无作者字段，id 在 route 层转 string）。 */
export interface FolderDto {
  folderId: number;
  name: string;
  parentId: number | null;
}

/** 资源列表项 DTO（不含 content，§7 载荷）。 */
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
  /** 锁内读回未删除资源 content（app 侧按 canonical JSON 计量，§4.2）。 */
  listActiveContent(exec: Queryable, organizationId: number): Promise<Record<string, unknown>[]>;
  /** 乐观锁更新（§4.3）：`WHERE id AND organization_id AND version=? AND delete_time IS NULL`；返回受影响的 skipper。 */
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

// ── 个人 E2E 同步（§8.1 专项）──

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
  /** active record 数 + 密文字节（配额计量：ciphertext+tag+nonce 长度，§8.1.9）。锁内执行。 */
  countActive(exec: Queryable, userId: number, keyEpoch: string): Promise<{ count: number; bytes: number }>;
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
}

export interface ISyncResetTokenRepo {
  create(exec: Queryable, input: { userId: number; tokenHash: Buffer; expiresTime: Date }): Promise<SyncResetToken>;
  /** 作废该用户全部未消费、未撤销 token（重新发起 challenge 前）。 */
  revokePendingByUser(exec: Queryable, userId: number, now: Date): Promise<void>;
  /** 事务内按 hash 锁定可用 token（未消费/未撤销/未过期）。 */
  findUsableForUpdate(exec: Queryable, tokenHash: Buffer): Promise<SyncResetToken | undefined>;
  /** 原子消费（`WHERE consumed_time IS NULL AND revoked_time IS NULL`）。 */
  consume(exec: Queryable, id: number, now: Date): Promise<boolean>;
}