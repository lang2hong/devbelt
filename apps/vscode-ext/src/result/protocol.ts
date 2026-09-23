/**
 * Webview 与扩展之间的消息协议类型（零 vscode 依赖，webview 也从此处 import）。
 *
 * 过去两端各自用裸字符串/`any`：`mode` 是一个字符串联合、消息只有隐式约定，改动
 * 靠人记。这里集中声明已知消息与视图模式，App.vue 与扩展侧共用，避免漂移。
 */

import type {
  AuthenticatorEntry,
  AuthenticatorGroup,
  AuthenticatorTag,
  TotpAlgorithm,
  TagColorKey,
} from '../authenticator/types';

/** App.vue 顶层视图模式（扩展在 `init` 消息里下发）。 */
export type WebviewMode =
  | 'query'
  | 'design'
  | 'status'
  | 'er'
  | 'connectionForm'
  | 'userManage'
  | 'dataDiff'
  | 'dashboard'
  | 'auditLog'
  | 'poolStatus'
  | 'loginForm'
  | 'session'
  | 'account'
  | 'plans'
  /** 账户中心：单面板 + 标签页（账户 / 设备 / 套餐）。 */
  | 'accountHub'
  /** P5：2FA/TOTP 验证器侧边栏视图。 */
  | 'authenticator';

/** 账户中心标签。 */
export type HubTab = 'account' | 'session' | 'plans';

/** 所有消息的松散基类：`type` 为判别字段，其余按具体消息扩展。 */
export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

/** 扩展 → webview：切换视图并下发语言。`isZh` 由 BaseWebView.post 统一注入。 */
export interface WebviewInitMessage extends WebviewMessage {
  type: 'init';
  mode?: WebviewMode;
  isZh?: boolean;
  /** accountHub 初始标签。 */
  tab?: HubTab;
}

/**
 * webview → 扩展：视图已挂载。
 *
 * `__load` 是本次 webview 加载的唯一标识（useVsCode 生成），扩展据此识别面板
 * 重载并重置「两次 ready」协议。
 */
export interface WebviewReadyMessage extends WebviewMessage {
  type: 'ready';
  __load?: string;
}

/** 扩展 → webview：统一错误边界兜底。 */
export interface WebviewErrorMessage extends WebviewMessage {
  type: 'error';
  message: string;
}

// ────────────────────────── P5：2FA/TOTP 验证器协议 ──────────────────────────
// 与 AuthenticatorViewProvider / AuthenticatorView.vue 共享的强类型契约。
// IPC 边界约定：凡"未分组/无目标/不存在"一律用 `null`（而非 undefined，避免 postMessage 丢字段）；
// 主进程入站时规范化为 Store 的 undefined，下发快照时把 undefined 归一化为 null。

/** 快照里的条目：groupId 用 null 表示未分组；secret 缺失时带 error 标记（UI 灰条）。 */
export type AuthenticatorSnapshotEntry =
  Omit<AuthenticatorEntry, 'groupId'> & { groupId: string | null; error?: 'secretMissing' };

/** webview → Extension Host。 */
export type AuthenticatorUpMessage =
  | { type: 'ready'; __load?: string }
  | { type: 'add'; entry: {
      issuer: string; account?: string; secret: string;
      algorithm: TotpAlgorithm; digits: 6 | 8; period: 30 | 60;
      groupId: string | null; tags: string[];
    } }
  | { type: 'update'; id: string; patch: {
      issuer?: string; account?: string; secret?: string;
      algorithm?: TotpAlgorithm; digits?: 6 | 8; period?: 30 | 60;
      groupId?: string | null; tags?: string[];
    } }
  | { type: 'delete'; id: string }
  | { type: 'addGroup'; name: string; afterId?: string; beforeId?: string }
  | { type: 'updateGroup'; id: string; name: string }
  | { type: 'deleteGroup'; id: string }
  | { type: 'moveEntry'; id: string; targetGroupId: string | null }
  | { type: 'reorderGroup'; orderedGroupIds: string[] }
  | { type: 'addTag'; name: string; color: TagColorKey }
  | { type: 'removeTag'; id: string }
  | { type: 'toggleGroup'; groupId: string | null; folded: boolean }
  | { type: 'requestAddForm' }
  | { type: 'copy'; code: string; entryId: string }
  | { type: 'export' };

/** Extension Host → webview。 */
export type AuthenticatorDownMessage =
  | { type: 'init'; mode: 'authenticator'; isZh: boolean }
  | { type: 'snapshot';
      entries: AuthenticatorSnapshotEntry[];
      groups: AuthenticatorGroup[];
      tags: AuthenticatorTag[];
    }
  | { type: 'tick'; nowMs: number; codes: Record<string, { code: string; secondsLeft: number }> }
  | { type: 'copyOk'; entryId: string }
  | { type: 'formError'; field?: string; message: string }
  | { type: 'openAddForm' }
  | { type: 'error'; message: string };
