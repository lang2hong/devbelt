import type { PlanCode, Role, SubStatus, PaymentProvider, SectionType, UserStatus } from './enums.js';
import type {
  OrgType,
  OrgStatus,
  MemberRole,
  MemberStatus,
  SeatStatus,
  OrderStatus,
  ResourceType,
  AccessScope,
  ResourcePermission,
} from './enums.js';

/**
 * 用户（全局身份）。
 * v2：移除 `plan_code`（其职责移交 organizations/subscriptions），
 * 个人额度由「有效席位套餐最高值」推导，不在此反范式冗余。
 */
export interface User {
  id: number;
  email: string;
  passwordHash: string;
  displayName?: string;
  role: Role;
  status: UserStatus;
  lastLoginTime?: Date;
  createTime: Date;
  updateTime: Date;
  deleteTime?: Date;
}

/**
 * 套餐定义（v2：per-seat / per-user / org 三段额度）。
 * `code` 是稳定标识，`id` 是外键目标（subscriptions/orders 引用 plan_id）。
 * `0` 表示该维度无限。seat_price_* 仅 team 套餐有值（personal 为 NULL）。
 */
export interface Plan {
  id: number;
  code: PlanCode;
  name: string;
  priceMonth: number;
  priceYear: number;
  seatPriceMonth?: number;
  seatPriceYear?: number;
  includedSeats: number;
  /** 每有效席位成员的设备数 */
  perSeatMaxDevices: number;
  /** 每有效席位成员的私人连接数 */
  perUserMaxPrivateConnections: number;
  /** 每有效席位成员的同时打开连接数 */
  perUserMaxOpenConnections: number;
  /** 每有效席位成员的私人同步密文配额（字节） */
  perUserPrivateSyncQuotaBytes: number;
  /** 每有效席位成员的同步版本保留数 */
  perUserSyncVersionRetention: number;
  /** 每有效席位成员的查询历史条数 */
  perUserHistoryRetentionCount: number;
  /** 组织共享连接模板数 */
  orgMaxSharedConnections: number;
  /** 组织共享资源加密载荷配额（字节） */
  orgSharedSyncQuotaBytes: number;
  /** 组织活跃成员数上限 */
  orgMaxMembers: number;
  features: number;
  createTime: Date;
  updateTime: Date;
}

/** 订阅（当前订阅，挂组织） */
export interface Subscription {
  id: number;
  organizationId: number;
  planId: number;
  status: SubStatus;
  periodStartTime?: Date;
  periodEndTime?: Date;
  trialEndTime?: Date;
  cancelTime?: Date;
  provider: PaymentProvider;
  externalId?: string;
  createTime: Date;
  updateTime: Date;
}

/** Refresh token（设备会话） */
export interface RefreshToken {
  id: number;
  userId: number;
  tokenHash: string;            // sha256 hex，不存明文
  deviceName?: string;
  deviceId?: string;            // 关联 devices.device_id（同设备判同键）
  userAgent?: string;
  ip?: string;
  expiresTime: Date;
  revokedTime?: Date;
  lastUsedTime?: Date;
  createTime: Date;
  updateTime: Date;
}

/** 设备实体（稳定固有信息，跨登录/重登不变） */
export interface Device {
  id: number;
  userId: number;
  deviceId: string;             // = os_machine_id（判同主键）
  hostname?: string;
  os?: string;
  arch?: string;
  osVersion?: string;
  appName?: string;
  appVersion?: string;
  remoteName?: string;
  vsMachineId?: string;          // vscode.env.machineId 原始值（可随重装变化，仅追溯）
  language?: string;
  timezone?: string;
  revokedTime?: Date;           // 非 NULL = 已解绑（不占配额）
  lastSeenTime?: Date;
  createTime: Date;
  updateTime: Date;
}

/** 连接元数据（明文，计量/分析；连接内容仍加密） */
export interface ConnectionMeta {
  id: number;
  userId: number;
  connId: string;               // 客户端连接 UUID（v2 列 conn_id）
  type: string;
  name?: string;
  groupName?: string;
  enabled: boolean;
  clientCreatedAt?: number;     // 客户端 epoch 毫秒，与服务端 create_time 区分
  clientUpdatedAt?: number;
  createTime: Date;
  updateTime: Date;
  deleteTime?: Date;            // 软删除墓碑，NULL=有效
}

/** 同步分节当前版本 */
export interface SyncSection {
  userId: number;
  section: SectionType;
  encryptedData: string;
  version: number;
  createTime: Date;
  updateTime: Date;
}

/** 同步分节历史版本（回滚用） */
export interface SyncSectionVersion {
  id: number;
  userId: number;
  section: SectionType;
  version: number;
  encryptedData: string;
  dataBytes: number;            // 该版本字节数（配额审计）
  createTime: Date;
  updateTime: Date;
}

/** 设备会话视图（/sessions 返回） */
export interface SessionInfo {
  id: number;
  deviceName?: string;
  ip?: string;
  createTime: Date;
  lastUsedTime?: Date;
  current: boolean;
}

/** 同步版本摘要（列版本用，不含密文） */
export interface SyncVersionSummary {
  version: number;
  dataBytes: number;
  createTime: Date;
}

/** 配额用量快照（/api/me 返回） */
export interface Usage {
  devices: number;
  connections: number;
  syncBytes: number;
  history: number;
}

/**
 * 管理操作留痕。
 *
 * `detail` 里放的是「改了什么」，通常形如 `{ role: { from, to } }` ——
 * 只记新值的话，「配额从多少改成多少」事后查不到。
 * 严禁写入口令散列、token 散列或任何凭据材料：审计表的读取门槛比
 * users 表低（运维排查会直接 SELECT），把凭据复制进来等于扩大暴露面。
 */
export interface AdminAuditLog {
  id: number;
  /** 操作者的 users.id。用户被删后仍保留记录，故不设外键级联删除 */
  actorUserId: number;
  actorEmail?: string;
  /** 形如 user.update / session.revoke / plan.update / ratelimit.update */
  action: string;
  targetType: string;
  /** 目标标识。用户是数字 id，套餐是 code，故统一存字符串 */
  targetId: string;
  detail: Record<string, unknown>;
  ip?: string;
  createTime: Date;
}

// ── v2：组织 / 成员 / 席位 / 订单 / 资源 / 权限 ──────────────────────
//
// 以下实体服务于以「组织」为计费主体的 v2 模型（见 docs/数据库设计v2.md §3）。
// 与上方 v1 实体并存：S3a 纯增量，不改 v1 的 User / Plan / Subscription。
// 字段命名与 DDL（001_initial_schema.ts）逐列对齐，行映射在 mysql 实现层完成。

/** 组织（计费主体；personal / team） */
export interface Organization {
  id: number;
  name: string;
  type: OrgType;
  /** 商业 Owner 的唯一权威（FK → users.id，ON DELETE RESTRICT） */
  ownerUserId: number;
  status: OrgStatus;
  createTime: Date;
  updateTime: Date;
  deleteTime?: Date;
}

/** 组织成员 + 角色（成员对席位的占用由此表表达） */
export interface Membership {
  id: number;
  organizationId: number;
  userId: number;
  /** 组织内角色；与全局系统 Role 不同命名空间 */
  role: MemberRole;
  status: MemberStatus;
  createTime: Date;
  updateTime: Date;
  deleteTime?: Date;
}

/** 席位（逐席数量；增减由订单 seat_delta 驱动） */
export interface Seat {
  id: number;
  subscriptionId: number;
  organizationId: number;
  status: SeatStatus;
  createTime: Date;
  updateTime: Date;
  deleteTime?: Date;
}

/** 订单 / 交易流水（不可变计账；S3 前需决定是否加 plan_snapshot） */
export interface Order {
  id: number;
  organizationId: number;
  subscriptionId?: number;
  planId: number;
  amount: number;
  currency: string;
  status: OrderStatus;
  provider: PaymentProvider;
  externalId?: string;
  /** 正数增加席位、负数减少、0 表示纯续费 */
  seatDelta: number;
  periodMonths: number;
  createTime: Date;
  updateTime: Date;
}

/**
 * 组织共享资源。
 *
 * `encryptedData` 是**服务端静态加密**载荷，不是用户级 E2E 密文：
 * 只允许 connection_template / query / folder，禁止保存数据库密码、
 * SSH 密码或 SSH 私钥。created_by / updated_by 刻意不设外键，成员离开后
 * 资源与审计来源仍可追溯。
 */
export interface OrganizationResource {
  id: number;
  organizationId: number;
  resourceType: ResourceType;
  name: string;
  accessScope: AccessScope;
  encryptedData: string;
  createdByUserId: number;
  updatedByUserId?: number;
  createTime: Date;
  updateTime: Date;
  deleteTime?: Date;
}

/** restricted 资源的显式授权（复合外键保证资源与成员属于同一组织） */
export interface OrganizationResourcePermission {
  id: number;
  organizationId: number;
  resourceId: number;
  membershipId: number;
  permission: ResourcePermission;
  createTime: Date;
  updateTime: Date;
}

/**
 * 组织协作审计。
 *
 * 刻意不设外键：组织或成员删除后留痕必须保留 —— 「谁把这个组织/成员删了」
 * 正是最需要追溯的一类操作，ON DELETE CASCADE 会把证据一起删掉。与
 * AdminAuditLog 同构：detail 存 JSON 文本（见 mysql/organizationAuditRepo）。
 */
export interface OrganizationAuditLog {
  id: number;
  organizationId: number;
  actorUserId?: number;
  action: string;
  resourceType?: string;
  resourceId?: number;
  detail?: Record<string, unknown>;
  ip?: string;
  createTime: Date;
}
