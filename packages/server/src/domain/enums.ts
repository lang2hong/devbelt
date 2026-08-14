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
} as const;

/** Feature 位值类型（供签名标注）。 */
export type FeatureFlag = (typeof Feature)[keyof typeof Feature];

/** PAT 作用域 */
export type PatScope = 'sync:read' | 'sync:write';
