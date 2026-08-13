/** 套餐代码 */
export type PlanCode = 'free' | 'pro' | 'team';

/** 用户角色（RBAC） */
export type Role = 'user' | 'admin';

/** 用户状态 */
export type UserStatus = 'active' | 'disabled';

/** 订阅状态 */
export type SubStatus = 'active' | 'trialing' | 'expired' | 'canceled';

/** 支付商（Adapter 适配目标） */
export type PaymentProvider = 'manual' | 'stripe' | 'lemonsqueezy';

/** 配额维度 */
export type QuotaType = 'devices' | 'connections' | 'sync_bytes' | 'pats' | 'history';

/** 同步分节（方案 A：分节存储） */
export type SectionType = 'groups' | 'connections' | 'queries' | 'folders' | 'history';

export const SECTION_TYPES: readonly SectionType[] = ['groups', 'connections', 'queries', 'folders', 'history'] as const;

/**
 * 功能位标志（features 位掩码）。
 * 不同套餐按位组合；客户端通过按位与判断是否可用。
 */
export const enum Feature {
  basic = 1 << 0,
  er_export = 1 << 1,
  excel = 1 << 2,
  datatransfer = 1 << 3,
  team_share = 1 << 4,
  audit_log = 1 << 5,
}

/** PAT 作用域 */
export type PatScope = 'sync:read' | 'sync:write';
