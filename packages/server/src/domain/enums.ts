/** 套餐代码 */
export type PlanCode = 'free' | 'pro' | 'team';

/** 用户角色（RBAC） */
export type Role = 'user' | 'admin';

/** 用户状态 */
export type UserStatus = 'active' | 'disabled';

/** 订阅状态 */
export type SubStatus = 'active' | 'trialing' | 'expired' | 'canceled';

/**
 * 周期结束后需要降级的订阅状态。
 *
 * - `active`：正常付费订阅，按 `period_end_time` 到期降级。
 * - `trialing`：建 team 组织时赠送的 14 天试用（`createOrganization` 写
 *   `trial_end_time`）。按 `trial_end_time` 到期降级，回落 free。
 *   若不纳入扫描，试用将永久挂付费套餐——这正是 #2 付费门禁旁路的根因。
 * - `canceled`：已取消但仍在已付周期内，周期结束同样要变 expired。
 *
 * `expired` 不在列表里：已是终态，重复处理只是白写一次 UPDATE。
 *
 * 这个常量必须由 service 与 repo 共用 —— 分别硬编码时两边一定会漂移，
 * 而漂移的表现是"扫描扫到了但 service 提前 return"这类静默失效。
 */
export const EXPIRABLE_STATUSES: readonly SubStatus[] = ['active', 'trialing', 'canceled'] as const;

/** 支付商（Adapter 适配目标） */
export type PaymentProvider = 'manual' | 'stripe' | 'lemonsqueezy';

/** 配额维度 */
export type QuotaType = 'devices' | 'connections' | 'sync_bytes' | 'history';

/** 同步分节（方案 A：分节存储） */
export type SectionType = 'groups' | 'connections' | 'queries' | 'folders' | 'history';

export const SECTION_TYPES: readonly SectionType[] = ['groups', 'connections', 'queries', 'folders', 'history'] as const;

/**
 * 功能位标志（features 位掩码）。
 * 不同套餐按位组合；客户端通过按位与判断是否可用。
 *
 * 用 `as const` 对象而非 `const enum`：`const enum` 会被 tsc 完全擦除，
 * 编译产物里既没有 `enums.js` 的导出也没有 `planPolicy.ts` 再导出的那份，
 * 运行时 `import { Feature }` 拿到 `undefined`（实测两处导出键分别只有
 * `SECTION_TYPES` 与 `PlanPolicy`）。vitest 走 esbuild 能跑通，编译产物不能，
 * 属于「测试绿、上线炸」的形态。与客户端 `sync/features.ts` 的写法保持一致。
 */
export const Feature = {
  basic: 1 << 0,
  er_export: 1 << 1,
  excel: 1 << 2,
  datatransfer: 1 << 3,
  team_share: 1 << 4,
  audit_log: 1 << 5,
  export_connections: 1 << 6,
} as const;

/** Feature 位值类型（供签名标注）。 */
export type FeatureFlag = (typeof Feature)[keyof typeof Feature];

// ── v2：组织 / 成员 / 席位 / 订单 / 资源 / 权限 ──────────────────────
//
// 以下枚举服务于以「组织」为计费主体的 v2 模型（见 docs/数据库设计v2.md）。
// 它们与上方 v1 枚举并存：S3a 纯增量，不改 v1 的 PlanCode / Role / SubStatus，
// 待 S3b/S3c 切换运行时后再清理。MemberRole 与全局系统 Role 是不同命名空间：
// 前者是组织内 admin/member，后者是系统级 user/admin。

/** 组织类型 */
export type OrgType = 'personal' | 'team';

/** 组织状态（沿用 UserStatus 的 active/disabled 约定） */
export type OrgStatus = 'active' | 'disabled';

/** 组织成员角色（组织内；区别于全局系统 Role） */
export type MemberRole = 'admin' | 'member';

/** 成员状态 */
export type MemberStatus = 'active' | 'disabled';

/** 席位状态（席位增减由订单 seat_delta 驱动） */
export type SeatStatus = 'active' | 'revoked';

/** 订单状态 */
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'canceled';

/** 组织共享资源类型（首期不含数据库密码 / SSH 私钥） */
export type ResourceType = 'connection_template' | 'query' | 'folder';

/** 资源访问范围 */
export type AccessScope = 'organization' | 'restricted';

/** 资源权限 */
export type ResourcePermission = 'read' | 'write';
