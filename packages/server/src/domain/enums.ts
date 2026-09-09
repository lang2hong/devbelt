/** 领域枚举。个人实体归 user_id，组织实体归 organization_id。 */

/** 用户状态（users.status）。 */
export type UserStatus = 'active' | 'disabled';

/** 用户平台角色（users.role，P3 切片 4）；仅平台管理员可读/操作运营页。 */
export type UserRole = 'user' | 'platform_admin';

/** 个人套餐状态。当前只 seed free。 */
export type PersonalPlanStatus = 'active' | 'archived';

/** 个人订阅状态。当前 Free 订阅永久 active。 */
export type PersonalSubscriptionStatus = 'active' | 'expired' | 'canceled';

/** 设备状态（devices.status）。revoked = 已撤销，不占配额。 */
export type DeviceStatus = 'active' | 'revoked';

/** 邮箱验证 token 用途。当前注册使用 initial。 */
export type EmailVerificationPurpose = 'initial' | 'email_change';

/** 个人免费套餐引擎权益：MySQL / SQLite（见实施规格 §4.2）。 */
export const PERSONAL_FREE_DATABASE_TYPES = ['mysql', 'sqlite'] as const;

// ── 组织域 ──

/** 组织状态（organizations.status）。closed 表示不可恢复的关闭状态。 */
export type OrganizationStatus = 'active' | 'closed';

/** 组织成员角色（预置 admin/member；无 owner）。 */
export type OrganizationRole = 'admin' | 'member';

/** 成员状态（memberships.status）。invited 由邀请流程写入。 */
export type OrganizationMembershipStatus = 'invited' | 'active' | 'removed';

/** 组织套餐状态。 */
export type OrganizationPlanStatus = 'active' | 'archived';

/** 组织订阅状态。当前 Free 订阅永久 active。 */
export type OrganizationSubscriptionStatus = 'active' | 'expired' | 'canceled';

// ── 组织资源 ──

/** 组织资源类型。 */
export type ResourceType = 'connection_template' | 'query';

// ── 个人端到端同步 ──

/** 当前同步协议版本。 */
export type SyncProtocolVersion = 1;

/** 当前密文格式版本。 */
export type SyncFormatVersion = 1;

/** 当前同步加密套件。 */
export type SyncCipherSuite = 'AES-256-GCM';

/** 需要签名证明的 mutation 动作（SigningInput.action，§7.4）。 */
export type SyncAction =
  | 'record.put'
  | 'record.delete'
  | 'state.change-key'
  | 'state.recover'
  | 'state.destroy';

/** mutation receipt 状态。 */
export type SyncMutationStatus = 'applied';

// ── 一次性邮件链接（mail-flow）──

/** 邮件流类型（token 来源的 token 表）。 */
export type MailFlowType = 'verify-email' | 'accept-invitation' | 'sync-reset';

/** 邮件流状态。issued = 已签发未消费，consumed = 已消费，expired = 过期，revoked = 撤销。 */
export type MailFlowStatus = 'issued' | 'consumed' | 'expired' | 'revoked';

// ── 会话 / token audience ──

/** access token 的 audience：extension（VS Code 扩展专用，含同步）与 console（浏览器控制台）。 */
export type TokenAudience = 'extension' | 'console';

/** 扩展端 token 的作用域（粗粒度；同步协议只在 extension 端暴露）。 */
export const EXTENSION_SCOPES = ['sync', 'account', 'device', 'organization'] as const;

/** 控制台 token 的作用域（不含 sync · E2EE 材料）。 */
export const CONSOLE_SCOPES = ['console', 'account', 'device', 'organization'] as const;
