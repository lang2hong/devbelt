/**
 * V3 领域枚举（Greenfield）。
 *
 * 只定义 Phase 1「身份与会话」切片需要并已冻结的值。个人/组织边界见
 * docs/v3/实施规格.md §2：个人实体只以 user_id 归属，组织实体只以
 * organization_id 归属；两者永不交叉计量。
 */

/** 用户状态（users.status）。账号删除状态属账号生命周期专项，Phase 1 不引入。 */
export type UserStatus = 'active' | 'disabled';

/** 个人套餐状态。Phase 1 只 seed/启用 free；archived 为将来商业目录预设。 */
export type PersonalPlanStatus = 'active' | 'archived';

/** 个人订阅状态。Phase 1 Free 永久 active；expired/canceled 为商业专项预留。 */
export type PersonalSubscriptionStatus = 'active' | 'expired' | 'canceled';

/** 设备状态（devices.status）。revoked = 已撤销，不占配额。 */
export type DeviceStatus = 'active' | 'revoked';

/** 邮箱验证 token 用途。Phase 1 只有 initial；email_change 属账号生命周期专项。 */
export type EmailVerificationPurpose = 'initial' | 'email_change';

/** 个人免费套餐引擎权益：MySQL / SQLite（见实施规格 §4.4）。 */
export const PERSONAL_FREE_DATABASE_TYPES = ['mysql', 'sqlite'] as const;

// ── 组织域（切片 2）──

/** 组织状态（organizations.status）。closed = 已关闭，不可恢复（Phase 1 无恢复路由）。 */
export type OrganizationStatus = 'active' | 'closed';

/** 组织成员角色（预置 admin/member；无 owner）。 */
export type OrganizationRole = 'admin' | 'member';

/** 成员状态（memberships.status）。invited 由邀请流程写入，Phase 1 切片 2 只用 active/removed。 */
export type OrganizationMembershipStatus = 'invited' | 'active' | 'removed';

/** 组织套餐状态。 */
export type OrganizationPlanStatus = 'active' | 'archived';

/** 组织订阅状态。Phase 1 Free 永久 active。 */
export type OrganizationSubscriptionStatus = 'active' | 'expired' | 'canceled';

// ── 组织资源（切片 4）──

/** 组织资源类型。 */
export type ResourceType = 'connection_template' | 'query';