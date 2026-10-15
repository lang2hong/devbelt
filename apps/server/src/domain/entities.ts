import type {
  UserStatus,
  UserRole,
  PersonalSubscriptionStatus,
  DeviceStatus,
  EmailVerificationPurpose,
  SyncProtocolVersion,
  SyncFormatVersion,
  SyncCipherSuite,
  SyncAction,
  SyncMutationStatus,
  MailFlowType,
  MailFlowStatus,
  SyncResetHandoffStatus,
  OrderStatus,
  PaymentChannel,
  PaymentResult,
  InvoiceStatus,
} from './enums.js';

/**
 * 领域实体。
 *
 * 约定：所有主键 `BIGINT UNSIGNED`，DB 列 snake_case，HTTP DTO camelCase。
 * 实体内部 id 用 number（mysql2 默认返回，实际值恒 < 2^53）；DTO 序列化在
 * route 层统一转十进制 string（实施规格 §2）。
 */

/** 用户（全局身份和个人空间所有者）。 */
export interface User {
  id: number;
  email: string;
  emailVerifiedTime: Date | null;
  passwordHash: string;
  displayName?: string;
  status: UserStatus;
  /** 平台角色（users.role，P3 切片 4）。 */
  role: UserRole;
  lastLoginTime: Date | null;
  /** 会话版本：改密/禁用时 +1，用于使所有存量 access token 立即失效（§4.1）。 */
  sessionVersion: number;
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

/** 套餐（个人）。特性为纵表派生，见 Plan.features。 */
export type PlanKind = 'personal';
export type PlanBillingUnit = 'month' | 'seat-month';
export type PlanStatus = 'active' | 'archived';

export interface PlanFeatureDef {
  id: number;
  key: string;
  kind: PlanKind | 'both';
  label: { en: string; zh: string };
  valueType: 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';
  unit: string | null;
  sortOrder: number;
}

export interface Plan {
  id: number;
  code: string;
  kind: PlanKind;
  name: string;
  /** 单价（CNY 分）；0 = 免费/待定价。 */
  priceCents: number;
  billingUnit: PlanBillingUnit;
  sortOrder: number;
  status: PlanStatus;
  /** 乐观并发版本；也是派生权益缓存的失效键。 */
  version: number;
  /** 纵表派生的特性取值，键为 feature_key。 */
  features: Record<string, unknown>;
  createTime: Date;
  updateTime: Date;
}

/** 个人订阅：只引用 plan，权益读取时派生（无快照）。 */
export interface PersonalSubscription {
  id: number;
  userId: number;
  planId: number;
  status: PersonalSubscriptionStatus;
  periodStartTime: Date;
  periodEndTime: Date | null;
  /** 乐观并发版本（P3 §6.2 订阅调整）。 */
  version: number;
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

// ── 个人端到端同步 ──

/** SMP 派生 KDF（仅 Argon2id；salt 16B、output 32B，§7.1）。 */
export interface SmpKdf {
  alg: 'argon2id';
  version: 1;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Buffer;
  outputBytes: 32;
}

/** 恢复码派生 KDF（仅 HKDF-SHA-256；§7.1）。 */
export interface RecoveryKdf {
  alg: 'hkdf-sha256';
  version: 1;
  salt: Buffer;
  outputBytes: 32;
}

/** 同步 envelope（加密后的 DEK：nonce 12B、ct 32B、tag 16B）。version 为十进制字符串（u64）。 */
export interface SyncEnvelope {
  version: string;
  nonce: Buffer;
  ct: Buffer;
  tag: Buffer;
}

/** 个人同步状态（每用户严格单行，§7.3）。u64 协议字段一律十进制字符串。 */
export interface PersonalSyncState {
  userId: number;
  keyEpoch: string;
  stateVersion: string;
  changeSequence: string;
  protocolVersion: SyncProtocolVersion;
  cipherSuite: SyncCipherSuite;
  formatVersion: SyncFormatVersion;
  smpKdf: SmpKdf;
  recoveryKdf: RecoveryKdf;
  envelopeSmp: SyncEnvelope;
  envelopeRecovery: SyncEnvelope;
  /** 账号恢复信封（第三把钥匙包裹的 DEK）；init 起必填，凡写入必非空。 */
  envelopeAccount: SyncEnvelope;
  /** 账号恢复钥匙（32B 明文托管，折中方案）；init 起必填。 */
  accountRecoveryKey: Buffer;
  signPub: Buffer;
  recoverSignPub: Buffer;
  recoveryCodeSetTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 个人 E2E record / tombstone（ciphertext/tag 于 tombstone 时为空）。u64 协议字段十进制字符串。 */
export interface PersonalConnectionMeta {
  id: number;
  userId: number;
  keyEpoch: string;
  recordId: Buffer;
  cipherSuite: SyncCipherSuite;
  formatVersion: SyncFormatVersion;
  nonce: Buffer;
  ciphertext: Buffer | null;
  tag: Buffer | null;
  /** P6：明文元数据（仅类型名，便于按类型计数/配额/统计）；旧记录为 null。 */
  entityKind: string | null;
  version: string;
  changeSequence: string;
  updateTime: Date;
  deleteTime: Date | null;
}

/** mutation receipt（冗等重放；只存定长字段）。u64 协议字段十进制字符串。 */
export interface SyncMutation {
  userId: number;
  keyEpoch: string;
  mutationId: Buffer;
  requestDigest: Buffer;
  action: SyncAction;
  resultVersion: string | null;
  resultChangeSequence: string | null;
  /** 该次 mutation 落实的恢复码设置时间（recover/recover-by-account 时记录；重放原样返回）。 */
  resultRecoveryCodeSetTime: Date | null;
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

/** sync-reset handoff（浏览器签发、扩展消费的一次性交接 ticket；ticket_hash 只存 SHA-256）。 */
export interface SyncResetHandoff {
  id: number;
  userId: number;
  resetTokenId: number;
  ticketHash: Buffer;
  /** 首次最终 reset 时写入（SHA-256 of JCS({ newState })），completed 回放比对用。 */
  requestDigest: Buffer | null;
  resultStateDtoJson: string | null;
  resultKeyEpoch: string | null;
  resultStateVersion: string | null;
  resultChangeSequence: string | null;
  status: SyncResetHandoffStatus;
  expiresTime: Date;
  consumedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

// ── 一次性邮件链接（mail-flow）──

/**
 * 邮件流：表示「曾持有效邮件链接」的短时 opaque 引用。不表示登录态、不直接授权。
 * type 决定目标 token 表；target_token_hash 只存 SHA-256 原始字节（BINARY(32)）。
 */
export interface MailFlow {
  id: number;
  type: MailFlowType;
  /** 认领时传入 token 的 SHA-256（raw 32 字节）。 */
  targetTokenHash: Buffer;
  /** 解析后对应 token 表行 id；未知/过期 token 无法解析时为 null。 */
  targetRecordId: number | null;
  /** 认领时未知用户为 null，登录绑定或已认领时写入。 */
  userId: number | null;
  /** Cookie nonce 的 SHA-256（raw 32 字节）。 */
  nonceHash: Buffer;
  status: MailFlowStatus;
  expiresTime: Date;
  consumedTime: Date | null;
  createTime: Date;
  updateTime: Date;
}

/** 审计事件（append-only，无 UPDATE/DELETE）。 */
export interface AuditEvent {
  id: number;
  eventTime: Date;
  actorUserId: number | null;
  actorRole: string | null;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  sourceIp: string | null;
  requestId: string | null;
  result: string;
  failureCode: string | null;
  /** 高危操作原因（仅受控写操作）。 */
  reason: string | null;
  createTime: Date;
}

/** 幂等回执（P3 §6.1）：同键同摘要重放，不重复业务写/审计。 */
export interface IdempotencyReceipt {
  id: number;
  actorUserId: number;
  sessionId: string;
  method: string;
  normalizedPath: string;
  idempotencyKey: string;
  requestDigest: Buffer;
  status: 'processing' | 'completed';
  httpStatus: number | null;
  responseBody: string | null;
  expiresTime: Date;
  createTime: Date;
  updateTime: Date;
}

// ── 支付（P4）──

/**
 * 支付订单（P4 §数据模型）。金额一律 CNY 分（BIGINT UNSIGNED），由后端按 plan_code
 * 计算，绝不接受前端传入金额；不存任何银行卡号/支付密码等敏感信息。
 */
export interface Order {
  id: number;
  /** 对外订单号（base64url opaque，避免自增 id 被枚举）。 */
  orderNo: string;
  userId: number;
  /** 订单用途（P9.1）：plan=套餐购买，topup=AI 加油包。 */
  purpose: 'plan' | 'topup';
  /** 套餐码（plan 订单必填；topup 订单为 null）。 */
  planCode: string | null;
  /** 购买时套餐版本（套餐可编辑；金额另由 amountCents 冻结）。 */
  planVersion: number;
  /** 加油包 SKU code（topup 订单必填；plan 订单为 null）。 */
  skuCode: string | null;
  amountCents: number;
  /** 下单渠道；manual 仅管理后台手工建单（不进 PAYMENT_CHANNELS，用户侧不可造）。 */
  channel: PaymentChannel | 'manual';
  status: OrderStatus;
  /** 支付平台交易号；回调到达后写入。 */
  channelTradeNo: string | null;
  paidTime: Date | null;
  /** 下单后未支付的过期时间（P4 §状态机：30 分钟）。 */
  expiresTime: Date;
  createTime: Date;
  updateTime: Date;
}

/** 支付流水（orders 一对多，支持多次回调/重试）。 */
export interface Payment {
  id: number;
  orderId: number;
  channel: PaymentChannel;
  channelTradeNo: string;
  amountCents: number;
  /** 渠道白名单脱敏摘要（不含原始信封/表单）。 */
  notifySummary: string | null;
  result: PaymentResult;
  createTime: Date;
}

/** 发票申请记录（抬头/税号/邮箱；状态登记，不生成发票文件本身）。 */
export interface Invoice {
  id: number;
  userId: number;
  orderId: number | null;
  title: string;
  taxNo: string | null;
  email: string;
  amountCents: number;
  status: InvoiceStatus;
  /** 驳回/失败原因（rejected/failed 时必填，其余为 null）。 */
  reason: string | null;
  createTime: Date;
  updateTime: Date;
}
