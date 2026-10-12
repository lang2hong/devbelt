/**
 * AI Chat 面板消息协议（P9 S3）。
 *
 * 独立于 `result/protocol.ts`：AI 面板是独立 WebviewPanel（`devbelt.ai`），
 * 不复用 QueryView/DesignView 的 WebviewMode 单入口，消息类型也不混入既有联合。
 * `type` 命名沿用既有「down = host → webview / up = webview → host」约定。
 */
import type { AiChatMessage, AiChatSession } from '../ai/aiSessionStore.js';

/** 上下文摘要（面板 ContextBar/状态条展示；不含 schema 原文）。 */
export interface AiContextState {
  connId?: string;
  connName?: string;
  dbType?: string;
  database?: string;
  schema?: string;
  tableCount: number;
  totalTables: number;
  commentCount: number;
  estimatedTokens: number;
  truncated?: boolean;
  /** S7a：作用域（库/逻辑库/索引）单选状态与候选。 */
  scopeKind?: 'database' | 'redis-db' | 'index';
  scope?: string;
  scopeOptions?: string[];
  /** schema 部分表元数据失败时跳过（不再整包失败）。 */
  partial?: boolean;
  /** 无可用连接/会话/作用域时的说明（UI 提示"未选择连接"等）。 */
  note?: 'no-connection' | 'no-session' | 'schema-failed' | 'no-database' | 'db-unreachable';
}

export interface AiQuotaState {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  resetAt: string;
}

export interface AiProviderState {
  mode: 'server-proxy' | 'openai-compatible';
  model: string;
  baseUrl: string;
  available: boolean;
  reason?: 'login-required' | 'api-key-missing' | 'not-configured';
}

export interface AiSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

// ── Down（host → webview）──

export interface AiInitDown {
  type: 'init';
  viewType: 'ai-chat';
  isZh?: boolean;
  provider: AiProviderState;
  quota: AiQuotaState | null;
  isLoggedIn: boolean;
  includeColumnComments: boolean;
  context: AiContextState;
  sessions: AiSessionSummary[];
  activeSessionId?: string;
  /** 连接选择器数据源（S3 手动选；自动跟随活动连接随 S4）。 */
  connections: { id: string; name: string }[];
}

export interface AiChunkDown {
  type: 'chunk';
  sessionId: string;
  delta: string;
}

export interface AiFinishDown {
  type: 'finish';
  sessionId: string;
  aborted?: boolean;
  error?: { code: string; message: string };
}

export interface AiQuotaUpdateDown {
  type: 'quotaUpdate';
  quota: AiQuotaState | null;
}

export interface AiContextChangedDown {
  type: 'contextChanged';
  context: AiContextState;
}

export interface AiSessionListDown {
  type: 'sessionList';
  sessions: AiSessionSummary[];
  activeSessionId?: string;
}

export interface AiSessionLoadedDown {
  type: 'sessionLoaded';
  session: AiChatSession;
}

/** 预填输入框（外部入口/refine 追问句式）。 */
export interface AiPrefillInputDown {
  type: 'prefillInput';
  text: string;
}

/** Context 抽屉明细（只读展示本次注入的 schema/域上下文/默认指令原文）。 */
export interface AiContextDetailDown {
  type: 'contextDetail';
  context: AiContextState;
  schemaText: string;
  domainContext: string;
  defaultDirectives: string;
}

export type AiDownMessage =
  | AiInitDown
  | AiChunkDown
  | AiFinishDown
  | AiQuotaUpdateDown
  | AiContextChangedDown
  | AiSessionListDown
  | AiSessionLoadedDown
  | AiPrefillInputDown
  | AiContextDetailDown;

// ── Up（webview → host）──

export interface AiSendUp {
  type: 'send';
  sessionId: string;
  text: string;
}

export interface AiSelectConnectionUp {
  type: 'selectConnection';
  connId: string | null;
}

/** S7a：切换作用域（库/逻辑库/索引，单选）。 */
export interface AiSelectScopeUp {
  type: 'selectScope';
  value: string;
}

export type AiUpMessage =
  | { type: 'ready' }
  | AiSendUp
  | { type: 'abort' }
  | { type: 'newChat' }
  | { type: 'renameChat'; sessionId: string; title: string }
  | { type: 'deleteChat'; sessionId: string }
  | { type: 'loadHistory'; sessionId: string }
  | AiSelectConnectionUp
  | AiSelectScopeUp
  | { type: 'requestQuotaRefresh' }
  | { type: 'openSettings' }
  | { type: 'setApiKey' }
  | { type: 'clearApiKey' }
  | { type: 'testConnection' }
  | { type: 'copyCode'; text: string }
  | { type: 'applyCode'; text: string }
  | { type: 'executeSql'; text: string }
  | { type: 'requestContextDetail' };

/** 会话消息类型在协议层再导出，webview 侧从 ai-protocol 单点取。 */
export type { AiChatMessage, AiChatSession };