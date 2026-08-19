import type { PlanCode, Role, SubStatus, PaymentProvider, SectionType, UserStatus } from './enums.js';

/** 用户 */
export interface User {
  id: number;
  email: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  planCode: PlanCode;
  lastLoginTime?: Date;
  createTime: Date;
  updateTime: Date;
}

/** 套餐定义 */
export interface Plan {
  code: PlanCode;
  name: string;
  priceMonth: number;
  priceYear: number;
  maxDevices: number;            // 0 = 无限
  maxConnections: number;        // 0 = 无限
  syncQuotaBytes: number;        // 0 = 无限
  syncVersionRetention: number;  // 同步历史版本保留数（0 = 不记历史）
  historyRetentionCount: number; // 查询历史条数（0 = 无限）
  features: number;              // Feature 位掩码
  createTime: Date;
  updateTime: Date;
}

/** 订阅 */
export interface Subscription {
  id: number;
  userId: number;
  planCode: PlanCode;
  status: SubStatus;
  periodEndTime: Date;
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
  deviceId: string;             // 硬件指纹（判同键）
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
  lastSeenTime?: Date;
  createTime: Date;
  updateTime: Date;
}

/** 设备事件留痕（升级/系统变化/首次登记） */
export interface DeviceEvent {
  id: number;
  userId: number;
  deviceId: string;
  event: 'register' | 'app_upgrade' | 'os_change';
  vsMachineId?: string;
  appName?: string;
  appVersion?: string;
  os?: string;
  osVersion?: string;
  arch?: string;
  createTime: Date;
}

/** 连接元数据（明文，计量/分析；连接内容仍加密） */
export interface ConnectionMeta {
  id: number;
  userId: number;
  connUuid: string;
  type: string;
  name?: string;
  groupName?: string;
  enabled: boolean;
  deleted: boolean;
  createdAt?: number;
  updatedAt?: number;
  createTime: Date;
  updateTime: Date;
}

/** 同步事件留痕（每次 pull/push 的明文元数据） */
export interface SyncEvent {
  id: number;
  userId: number;
  deviceId?: string;
  direction: 'pull' | 'push';
  section: string;
  bytes: number;
  itemCount: number;
  createTime: Date;
}

/** 用量行为事件（连接打开 / 查询执行的累计计数） */
export interface UsageEvent {
  id: number;
  userId: number;
  deviceId?: string;
  kind: 'connection_open' | 'query_execute';
  count: number;
  createTime: Date;
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
