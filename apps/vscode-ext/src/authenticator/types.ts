/**
 * TOTP 验证器相关数据类型、持久化键常量与 SecretStorage 键名辅助。
 *
 * 设计约束（与 IPC 边界对齐）：
 * - 持久化模型里"未分组"= `groupId === undefined`；IPC 入站用 `null` 表示未分组，
 *   由 Store 入站规范化为 `undefined`。
 * - SecretStorage key 统一前缀 `devbelt.authenticator.<id>.secret`；
 *   读写 **必须** 走 `secretKey(id)`/`parseSecretKey(key)`，禁止直接字符串拼 key
 *   （否则 secrets.onDidChange 回调里无法可靠反解 entry id，缓存会脏）。
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** 标签调色板 8 色 key（前端样式映射 + Store 白名单校验共用）。不存 hex。 */
export const AUTHENTICATOR_TAG_COLORS = [
  'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'cyan', 'gray',
] as const;
export type TagColorKey = typeof AUTHENTICATOR_TAG_COLORS[number];

/**
 * 用户自定义分组。
 * 注意：不存在"默认/未分组"持久化记录——Store 持久化模型里未分组 =
 *  `groupId === undefined`；IPC 边界用 null 表示未分组（见协议章节）；
 * UI 在渲染时固定提供"未分组"折叠区（标题走 i18n，不可删/不可重命名）。
 */
export type AuthenticatorGroup = {
  id: string;
  name: string;
  sortOrder: number;
  /** P6：持久墓碑（同步出站据此产 record.delete）；UI/`listGroups` 过滤。 */
  deleted?: boolean;
  updateTime?: number;
};

export type AuthenticatorTag = {
  id: string;
  name: string;
  color: TagColorKey; // 8 色 key 之一，Store 校验白名单
  /** P6：持久墓碑；UI/`listTags` 过滤。 */
  deleted?: boolean;
  updateTime?: number;
};

export type AuthenticatorEntry = {
  id: string; // uniqueId('ae') —— entry 前缀用 'ae'，给未来同步实体留 'a'
  issuer: string;
  account?: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: 30 | 60;
  groupId?: string; // 指向 groups[].id；undefined/空串/找不到对应 group 时 UI 回落到「未分组」
  tags: string[]; // tag id 数组
  createTime: number;
  updateTime: number;
  /**
   * P6：仅本地派生态——该条目因配额被服务端拒绝入同步（配合 `syncError:'quota'`）。
   * **不进同步 payload**（否则会随整条 LWW 被覆盖）。
   */
  localOnly?: boolean;
  /** P6：仅本地派生态——同步被拒原因；**不进同步 payload**。 */
  syncError?: 'quota';
  /** P6：持久墓碑（`deleteEntry` 置位；UI/`listEntries` 过滤，同步出站产 record.delete）。 */
  deleted?: boolean;
};
// secret 不在 entry 里，单独 SecretStorage

/** globalState 键（context.globalState，跨项目持久化；不要用 workspaceState）。 */
export const ENTRIES_KEY = 'devbelt.authenticator.entries';
export const GROUPS_KEY = 'devbelt.authenticator.groups';
export const TAGS_KEY = 'devbelt.authenticator.tags';

export const SECRET_KEY_PREFIX = 'devbelt.authenticator.';
export const SECRET_KEY_SUFFIX = '.secret';

/**
 * 拼 SecretStorage 键：
 * - 未登录（`local`）：`devbelt.authenticator.<id>.secret`（保持旧格式，兼容已有数据）；
 * - 已登录：`devbelt.authenticator.u.<scope>.<id>.secret`，与连接凭据同一套作用域语义。
 */
export function secretKey(id: string, scope: string = 'local'): string {
  const prefix = scope === 'local' ? SECRET_KEY_PREFIX : `${SECRET_KEY_PREFIX}u.${scope}.`;
  return `${prefix}${id}${SECRET_KEY_SUFFIX}`;
}

/**
 * 从 SecretStorage key 反解当前作用域下的 entry id；不属于当前作用域返回 null。
 * 供 secrets.onDidChange 回调过滤其他模块（连接凭据）与**其他账号**的密钥变更。
 */
export function parseSecretKey(key: string, scope: string = 'local'): string | null {
  const prefix = scope === 'local' ? SECRET_KEY_PREFIX : `${SECRET_KEY_PREFIX}u.${scope}.`;
  if (!key.startsWith(prefix) || !key.endsWith(SECRET_KEY_SUFFIX)) return null;
  const id = key.slice(prefix.length, key.length - SECRET_KEY_SUFFIX.length);
  // 未登录时不把 `u.<scope>.<id>` 误认成 entry id
  if (!id || id.includes('.')) return null;
  return id;
}
