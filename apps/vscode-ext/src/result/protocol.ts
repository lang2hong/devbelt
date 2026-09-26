/**
 * Webview 与扩展之间的消息协议类型（零 vscode 依赖，webview 也从此处 import）。
 *
 * 过去两端各自用裸字符串/`any`：`mode` 是一个字符串联合、消息只有隐式约定，改动
 * 靠人记。这里集中声明已知消息与视图模式，App.vue 与扩展侧共用，避免漂移。
 */

import type { RedisKeyFolder } from './redisKeyFold';
export type { RedisKeyFolder };
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
  | 'authenticator'
  /** P7：Redis 面板（Status / CLI / SlowLog）。 */
  | 'redis';

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
  | { type: 'addUri'; uri: string }
  | { type: 'addImage'; dataUrl: string }
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
  | { type: 'formError'; field?: string; message: string; source?: 'form' | 'external' }
  | { type: 'openAddForm' }
  | { type: 'error'; message: string };

// ────────────────────────── P7：Redis 面板协议 ──────────────────────────
// 与 RedisView.ts / RedisView.vue 共享。IPC 边界约定同上：缺失值一律用 `null`。

/** SLOWLOG GET 单条（已归一化，供 webview 直接渲染）。 */
export interface RedisSlowlogEntry {
  id: number;
  timestamp: number;
  durationMicros: number;
  command: string;
  clientAddr: string;
  clientName: string;
}

/** 命令日志条目（host → webview，逐条下发）。 */
export interface RedisCommandLogEntry {
  command: string;
  args: string[];
  durationMs: number;
  ok: boolean;
  error: string | null;
}
/** Redis 面板类型（S5：按职责拆分为独立 webview）。 */
export type RedisPanel = 'keyBrowser' | 'serverStatus' | 'console' | 'slowlog' | 'commandLog';

/** Extension Host → webview。 */
export type RedisDownMessage =
  | { type: 'init'; mode: 'redis'; isZh: boolean }
  | { type: 'config'; connName: string; host: string; port: number; db: number | null;
      readOnly: boolean; connMode: 'standalone' | 'cluster' | 'sentinel'; panel: RedisPanel;
      commands: string[] }
  | { type: 'info'; info: string }
  | { type: 'slowlog'; entries: RedisSlowlogEntry[] }
  | { type: 'keys'; folders: RedisKeyFolder; cursor: string; done: boolean; scanned: number; match: string }
  | { type: 'value'; key: string; keyType: string; ttl: number; tooLarge: boolean; size: number | null; data: RedisValueData | null }
  | { type: 'keyAction'; action: string; ok: boolean; error: string | null }
  | { type: 'confirmOpRequired'; kind: string; detail: string }
  | { type: 'commandLog'; entry: RedisCommandLogEntry }
  | { type: 'connectionEvent'; event: string; detail: string | null; at: number }
  | { type: 'streamGroupDetail'; key: string; group: string; consumers: Record<string, string>[]; pending: { count: number; minId: string; maxId: string; consumers: [string, string][] } }
  | { type: 'streamRangeResult'; key: string; entries: RedisStreamEntry[]; done: boolean }
  | { type: 'commandResult'; id: string; command: string; ok: boolean; result: string; costMs: number; error: string | null }
  | { type: 'confirmRequired'; id: string; command: string }
  | { type: 'error'; message: string };

/** 绑定值数据（按 key 类型）。 */
/** Stream 条目（结构与 db-core RedisStreamEntry 一致）。 */
export interface RedisStreamEntry {
  id: string;
  fields: [string, string][];
}

export type RedisValueData =
  | { kind: 'string'; text: string; base64: string; binary: boolean; bytes: number }
  | { kind: 'hash'; entries: [string, string][]; len: number }
  | { kind: 'list'; items: string[]; len: number }
  | { kind: 'set'; members: string[]; card: number }
  | { kind: 'zset'; items: [string, string][]; card: number }
  | { kind: 'stream'; entries: RedisStreamEntry[]; len: number; groups: Record<string, string>[] };

/** 新建 key 的初值（按类型）。 */
export type RedisNewKeyValue =
  | { kind: 'string'; text: string }
  | { kind: 'hash'; entries: [string, string][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'set'; members: string[] }
  | { kind: 'zset'; items: [string, string][] };

/** webview → Extension Host。 */
export type RedisUpMessage =
  | { type: 'ready'; __load?: string }
  | { type: 'runCommand'; id: string; line: string }
  | { type: 'confirmDanger'; id: string; accept: boolean }
  | { type: 'refreshInfo' }
  | { type: 'refreshSlowlog' }
  // S3 键树 / 值 / CRUD
  | { type: 'refreshKeys'; match?: string; count?: number }
  | { type: 'loadMoreKeys' }
  | { type: 'selectKey'; key: string }
  | { type: 'saveString'; key: string; value: string }
  | { type: 'saveStringBytes'; key: string; base64: string }
  | { type: 'appendString'; key: string; value: string }
  | { type: 'setTtl'; key: string; seconds: number }
  | { type: 'persistKey'; key: string }
  | { type: 'renameKey'; key: string; newKey: string }
  | { type: 'deleteKeys'; keys: string[] }
  | { type: 'createKey'; key: string; value: RedisNewKeyValue; ttlSeconds: number | null }
  | { type: 'hashSet'; key: string; field: string; value: string }
  | { type: 'hashDel'; key: string; fields: string[] }
  | { type: 'listPush'; key: string; side: 'left' | 'right'; values: string[] }
  | { type: 'listSet'; key: string; index: number; value: string }
  | { type: 'listRem'; key: string; count: number; value: string }
  | { type: 'listTrim'; key: string; start: number; stop: number }
  | { type: 'listPop'; key: string; side: 'left' | 'right' }
  | { type: 'setAdd'; key: string; members: string[] }
  | { type: 'setRem'; key: string; members: string[] }
  | { type: 'zsetAdd'; key: string; score: string; member: string }
  | { type: 'zsetRem'; key: string; members: string[] }
  // Stream（S4）：破坏性操作须 confirmed=true 才执行（host 先回 confirmOpRequired）。
  | { type: 'streamAdd'; key: string; id: string; fields: [string, string][] }
  | { type: 'streamDel'; key: string; ids: string[]; confirmed?: boolean }
  | { type: 'streamTrim'; key: string; maxlen: number; confirmed?: boolean }
  | { type: 'streamGroupCreate'; key: string; group: string; id: string; mkstream: boolean }
  | { type: 'streamGroupDestroy'; key: string; group: string; confirmed?: boolean }
  | { type: 'streamGroupDelConsumer'; key: string; group: string; consumer: string; confirmed?: boolean }
  | { type: 'streamGroupDetail'; key: string; group: string }
  | { type: 'streamRange'; key: string; start: string };
