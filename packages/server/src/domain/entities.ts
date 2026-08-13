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
  maxPats: number;
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
  userAgent?: string;
  ip?: string;
  expiresTime: Date;
  revokedTime?: Date;
  lastUsedTime?: Date;
  createTime: Date;
}

/** 个人访问令牌 PAT */
export interface Pat {
  id: number;
  userId: number;
  name: string;
  tokenHash: string;
  scopes: string;                // 逗号分隔
  lastUsedTime?: Date;
  expiresTime?: Date;
  revokedTime?: Date;
  createTime: Date;
}

/** 同步分节当前版本 */
export interface SyncSection {
  userId: number;
  section: SectionType;
  encryptedData: string;
  version: number;
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
  pats: number;
  history: number;
}
