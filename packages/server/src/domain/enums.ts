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
 * 原先只有 `'active'` 参与到期扫描，于是 trialing 与 canceled 的行**永远
 * 不会被处理**：
 *  - 注册时写的是 `status: 'trialing'`（authService.register），用户 7 天后
 *    `/api/me` 仍显示 trialing，界面上"试用中"永久挂着；这些行也永不被
 *    `idx_sub_status_period` 扫到，积在表里只增不减。
 *  - `canceled` 是"已取消但仍在已付周期内"，周期结束同样要变 expired；
 *    不处理的话取消过的用户会一直保持付费套餐。
 *
 * 眼下试用给的是 free 套餐，所以 trialing 不漏钱 —— 但这是定时炸弹：
 * 试用给付费套餐是最常见的做法，authService 里的 planCode 一改成 'pro'，
 * 同一段代码立刻变成"所有试用用户永久免费用 pro"。
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
} as const;

/** Feature 位值类型（供签名标注）。 */
export type FeatureFlag = (typeof Feature)[keyof typeof Feature];
