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

export interface MeResponse {
  user: UserInfo;
}

export interface LoginResponse {
  token: string;
  user: UserInfo;
  role: string;
}