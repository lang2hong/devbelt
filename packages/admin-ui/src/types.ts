export type Role = 'user' | 'admin';
export type UserStatus = 'active' | 'disabled';

export interface UserInfo {
  id: number;
  email: string;
  role: Role;
  status: UserStatus;
  planCode: string;
  lastLoginTime?: string;
  createTime: string;
  updateTime: string;
}

export interface UserRow extends UserInfo {
  subscription?: { planCode: string; status: string; periodEndTime?: string };
}

export interface Plan {
  code: string;
  name: string;
  priceMonth: number;
  priceYear: number;
  maxConnections: number;
  syncQuotaBytes: number;
  syncVersionRetention: number;
  features: number;
}

export interface Subscription {
  id: number;
  userId: number;
  planCode: string;
  status: string;
  periodEndTime?: string;
  trialEndTime?: string;
  cancelTime?: string;
  provider?: string;
  externalId?: string;
  createTime: string;
}

export interface SubscriptionRow extends Subscription {
  email?: string;
}

export interface SessionInfo {
  id: number;
  deviceName?: string;
  ip?: string;
  createTime: string;
  lastUsedTime?: string;
  current: boolean;
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
  usage: { devices: number; syncBytes: number; sections: SectionUsage[] };
}

export interface Device {
  id: number;
  deviceId: string;
  hostname?: string;
  os?: string;
  arch?: string;
  appName?: string;
  appVersion?: string;
  remoteName?: string;
  language?: string;
  lastSeenTime?: string;
}

export interface DeviceEvent {
  id: number;
  event: string;
  appName?: string;
  appVersion?: string;
  os?: string;
  osVersion?: string;
  createTime: string;
}

export interface ConnectionMeta {
  id: number;
  type: string;
  name?: string;
  groupName?: string;
  enabled: boolean;
  deleted: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface SyncEvent {
  id: number;
  direction: string;
  section: string;
  bytes: number;
  itemCount: number;
  createTime: string;
}

export interface UsageEvent {
  id: number;
  kind: string;
  count: number;
  createTime: string;
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

export interface HourPoint {
  bucketTime: string;
  total: number;
  byClass: Record<number, number>;
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
  hourly: HourPoint[];
  minutes: MinutePoint[];
  blocked: BlockedRow[];
  blockedTotal: number;
}

export interface RateLimitRuleRow {
  bucket: string;
  maxRequests: number;
  windowSeconds: number;
  enabled: boolean;
  description: string;
  /** 与代码内置基线一致时为 true，用来提示哪些被改过 */
  isDefault: boolean;
}

export interface RateLimitResponse {
  rules: RateLimitRuleRow[];
  allowlist: string[];
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
  token: string;
  user: UserInfo;
  role: string;
}