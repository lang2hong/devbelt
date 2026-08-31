import type {
  UserStatus,
  PersonalPlanStatus,
  PersonalSubscriptionStatus,
  DeviceStatus,
  EmailVerificationPurpose,
  OrganizationStatus,
  OrganizationRole,
  OrganizationMembershipStatus,
  OrganizationPlanStatus,
  OrganizationSubscriptionStatus,
  ResourceType,
  SyncProtocolVersion,
  SyncFormatVersion,
  SyncCipherSuite,
  SyncAction,
  SyncMutationStatus,
} from './enums.js';

/**
 * V3 Phase 1 领域实体（身份与会话切片）。
 *
 * 约定：所有主键 `BIGINT UNSIGNED`，DB 列 snake_case，HTTP DTO camelCase。
 * 实体内部 id 用 number（mysql2 默认返回，实际值恒 < 2^53）；DTO 序列化在
 * route 层统一转十进制 string（实施规格 §2.1）。
 */

/** 用户（全局身份）。个人空间所有者；组织成员关系属后续切片。 */
export interface User {
  id: number;
  email: string;
  emailVerifiedTime: Date | null;
  passwordHash: string;
  displayName?: string;
  status: UserStatus;
  lastLoginTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 邮箱验证 token。只存 SHA-256 hash，有效期 24 小时，单次消费。 */
export interface EmailVerificationToken {
  id: number;
  userId: number;
  email: string;
  purpose: EmailVerificationPurpose;
  tokenHash: string;
  expiresTime: Date;
  consumedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 个人套餐定义。Phase 1 只 seed free。 */
export interface PersonalPlan {
  id: number;
  code: string;
  name: string;
  /** JSON：允许的数据库引擎（个人 Free = mysql/sqlite） */
  allowedDatabaseTypes: string[];
  /** 设备数上限；0 = 无限 */
  maxDevices: number;
  /** 云端同步连接元数据条数；0 = 无限（§8.1.6） */
  maxConnectionMetas: number;
  /** 云端同步密文总字节配额；0 = 无限（§8.1.6） */
  syncStorageBytes: number;
  status: PersonalPlanStatus;
  createTime: Date;
  updateTime: Date;
}

/** 个人订阅（users 的当前权益）。entitlement_snapshot 冻结套餐权益。 */
export interface PersonalSubscription {
  id: number;
  userId: number;
  planId: number;
  status: PersonalSubscriptionStatus;
  /** JSON：不可变权益快照（引擎、设备数等） */
  entitlementSnapshot: Record<string, unknown>;
  periodStartTime: Date;
  periodEndTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 设备。device_key 由客户端生成并持久化，UNIQUE(user_id, device_key)。 */
export interface Device {
  id: number;
  userId: number;
  deviceKey: string;
  devicePlatform: string;
  deviceName: string;
  clientVersion: string;
  status: DeviceStatus;
  lastUsedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** Refresh token（会话）。family_id 用于复用检测时撤销整族。 */
export interface RefreshToken {
  id: number;
  userId: number;
  deviceId: number | null;
  tokenHash: string;
  familyId: string;
  replacedByTokenId: number | null;
  expiresTime: Date;
  revokedTime: Date | null;
  lastUsedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 设备列表 DTO（不含 token/hash，仅本人可读字段）。 */
export interface DeviceInfoDto {
  deviceId: string;
  devicePlatform: string;
  deviceName: string;
  clientVersion: string;
  status: DeviceStatus;
  lastUsedTime: Date | null;
  createTime: Date;
}

// ── 组织域（切片 2）──

/** 组织（协作空间）。无 Owner 字段；创建组织的用户成为首位 active admin。 */
export interface Organization {
  id: number;
  name: string;
  status: OrganizationStatus;
  closedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 组织套餐定义（Phase 1 只 seed organization_free）。 */
export interface OrganizationPlan {
  id: number;
  code: string;
  name: string;
  includedSeats: number;
  maxSharedResources: number;
  sharedStorageQuotaBytes: number;
  allowedTemplateDatabaseTypes: string[];
  status: OrganizationPlanStatus;
  createTime: Date;
  updateTime: Date;
}

/** 组织订阅（organizations 的当前权益）。 */
export interface OrganizationSubscription {
  id: number;
  organizationId: number;
  planId: number;
  seatLimit: number;
  status: OrganizationSubscriptionStatus;
  entitlementSnapshot: Record<string, unknown>;
  periodStartTime: Date;
  periodEndTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 组织成员关系。membership 只存一个 role。 */
export interface OrganizationMembership {
  id: number;
  organizationId: number;
  userId: number;
  role: OrganizationRole;
  status: OrganizationMembershipStatus;
  invitedByUserId: number | null;
  joinedTime: Date | null;
  removedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 组织邀请（切片 3）。token_hash 只存 SHA-256，有效期 7 天，单次消费。 */
export interface OrganizationInvitation {
  id: number;
  organizationId: number;
  membershipId: number;
  email: string;
  tokenHash: string;
  expiresTime: Date;
  acceptedTime: Date | null;
  revokedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

// ── 组织资源（切片 4）──

/** 组织目录。无作者字段；软删除置 delete_time。 */
export interface Folder {
  id: number;
  organizationId: number;
  parentId: number | null;
  name: string;
  deleteTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 组织资源（connection_template / query）。content 为开放 JSON（4.4 节闭合 schema 校验）。 */
export interface Resource {
  id: number;
  organizationId: number;
  folderId: number | null;
  resourceType: ResourceType;
  name: string;
  content: Record<string, unknown>;
  version: number;
  createdByMembershipId: number;
  updatedByMembershipId: number | null;
  deleteTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

// ── 个人 E2E 同步（§8.1 专项）──

/** SMP 派生 KDF（仅 Argon2id；salt 16B、output 32B，§8.1.2）。 */
export interface SmpKdf {
  alg: 'argon2id';
  version: 1;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Buffer;
  outputBytes: 32;
}

/** 恢复码派生 KDF（仅 HKDF-SHA-256；§8.1.2）。 */
export interface RecoveryKdf {
  alg: 'hkdf-sha256';
  version: 1;
  salt: Buffer;
  outputBytes: 32;
}

/** 同步 envelope（加密后的 DEK：nonce 12B、ct 32B、tag 16B）。 */
export interface SyncEnvelope {
  version: number;
  nonce: Buffer;
  ct: Buffer;
  tag: Buffer;
}

/** 个人同步状态（每用户严格单行，§8.1.5）。 */
export interface PersonalSyncState {
  userId: number;
  keyEpoch: number;
  stateVersion: number;
  changeSequence: number;
  protocolVersion: SyncProtocolVersion;
  cipherSuite: SyncCipherSuite;
  formatVersion: SyncFormatVersion;
  smpKdf: SmpKdf;
  recoveryKdf: RecoveryKdf;
  envelopeSmp: SyncEnvelope;
  envelopeRecovery: SyncEnvelope;
  signPub: Buffer;
  recoverSignPub: Buffer;
  recoveryCodeSetTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 个人 E2E record / tombstone（ciphertext/tag 于 tombstone 时为空）。 */
export interface PersonalConnectionMeta {
  id: number;
  userId: number;
  keyEpoch: number;
  recordId: Buffer;
  cipherSuite: SyncCipherSuite;
  formatVersion: SyncFormatVersion;
  nonce: Buffer;
  ciphertext: Buffer | null;
  tag: Buffer | null;
  version: number;
  changeSequence: number;
  updateTime: Date;
  deleteTime: Date | null;
}

/** mutation receipt（冗等重放；只存定长字段）。 */
export interface SyncMutation {
  userId: number;
  keyEpoch: number;
  mutationId: Buffer;
  requestDigest: Buffer;
  action: SyncAction;
  resultVersion: number | null;
  resultChangeSequence: number | null;
  status: SyncMutationStatus;
  expiresTime: Date;
  createTime: Date;
}

/** reset-after-loss 邮箱挑战 token（token_hash 只存 SHA-256）。 */
export interface SyncResetToken {
  id: number;
  userId: number;
  tokenHash: Buffer;
  expiresTime: Date;
  consumedTime: Date | null;
  revokedTime: Date | null;
  createTime: Date;
}