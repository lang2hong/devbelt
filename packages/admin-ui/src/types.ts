export type Role = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled';

export interface UserInfo {
  id: number;
  email: string;
  displayName?: string;
  role: Role;
  status: UserStatus;
  lastLoginTime?: string;
  createTime: string;
  updateTime: string;
}

export interface UserRow extends UserInfo {}

export interface Plan {
  id: number;
  code: string;
  name: string;
  priceMonth: number;
  priceYear: number;
  seatPriceMonth?: number;
  seatPriceYear?: number;
  includedSeats: number;
  perSeatMaxDevices: number;
  perUserMaxPrivateConnections: number;
  perUserMaxOpenConnections: number;
  perUserPrivateSyncQuotaBytes: number;
  perUserSyncVersionRetention: number;
  perUserHistoryRetentionCount: number;
  orgMaxSharedConnections: number;
  orgSharedSyncQuotaBytes: number;
  orgMaxMembers: number;
  features: number;
  createTime: string;
  updateTime: string;
}

export interface Subscription {
  id: number;
  organizationId: number;
  planId: number;
  status: string;
  periodStartTime?: string;
  periodEndTime?: string;
  trialEndTime?: string;
  cancelTime?: string;
  provider: string;
  externalId?: string;
  createTime: string;
  updateTime: string;
}

export interface SubscriptionRow extends Subscription {
  organizationName?: string;
}

export interface SessionInfo {
  id: number;
  deviceName?: string;
  ip?: string;
  createTime: string;
  lastUsedTime?: string;
}

export interface SectionUsage {
  section: string;
  version: number;
  bytes: number;
  updateTime: string;
}

export interface AdminUserDetail {
  user: UserInfo;
  plan: Plan;
  subscription?: Subscription;
  sessions: SessionInfo[];
  memberships: Array<{ organizationId: number; organizationName: string; role: string; status: string }>;
  usage: { devices: number; syncBytes: number; sections: SectionUsage[] };
}

export interface Device {
  id: number;
  deviceId: string;
  hostname?: string;
  os?: string;
  arch?: string;
  osVersion?: string;
  appName?: string;
  appVersion?: string;
  remoteName?: string;
  vsMachineId?: string;
  language?: string;
  timezone?: string;
  lastSeenTime?: string;
  revokeTime?: string;
}

export interface ConnectionMeta {
  id: number;
  userId: number;
  connId: string;
  type: string;
  name?: string;
  groupName?: string;
  enabled: boolean;
  clientCreatedAt?: number;
  clientUpdatedAt?: number;
  createTime: string;
  updateTime: string;
  deleteTime?: string;
}

/**
 * 流量报表。
 *
 * 全部字段都是服务端算好的 —— 这些组件刻意不做聚合，因为 admin-ui 没有
 * 测试运行器，聚合逻辑放在服务端（TrafficReporter）才有测试覆盖。
 */
export interface RouteSummary {
  route: string;
  total: number;
  ok: number;
  clientError: number;
  serverError: number;
  /** 0..1 */
  errorRate: number;
}

export interface MinutePoint {
  minuteTs: number;
  total: number;
  byClass: Record<number, number>;
}

export interface BlockedRow {
  ip: string;
  route: string;
  bucket: string;
  createTime: string;
}

export interface TrafficReport {
  hours: number;
  total: number;
  routes: RouteSummary[];
  hourly: MinutePoint[];
  minutes: MinutePoint[];
  blocked: BlockedRow[];
  blockedTotal: number;
}

/** 管理操作留痕行。detail 是 { field: { from, to } } 或任意形状的补充信息 */
export interface AuditRow {
  id: number;
  actorUserId: number;
  actorEmail?: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  ip?: string;
  createTime: string;
}

export interface AuditResponse {
  total: number;
  entries: AuditRow[];
}

export interface MeResponse {
  user: UserInfo;
}

export interface LoginResponse {
  accessToken: string;
  user: UserInfo;
}
