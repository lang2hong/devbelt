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
  /** 表选择抽屉：当前勾选的表（空/缺省 = 自动模式）。 */
  selectedTables?: string[];
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
  /** 月段剩余（P9.1 双段配额条；旧数据缺失时回退 remaining）。 */
  monthlyRemaining: number;
  /** 加油包可用余额（P9.1；缺失时为 0）。 */
  topupRemaining: number;
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
  /**
   * 权威最终正文（P9 保留字补引）：host 收流后对 ```sql 块做过本地修正的版本。
   * 存在时 webview 以它替换流式累积缓冲——显示/自动执行/编辑器插入三者一致；
   * 缺省（无正文）沿用旧行为。
   */
  content?: string;
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
  /** 本次实际注入的表清单（SQL 引擎；可点击进入表/列说明编辑器）。 */
  tables?: string[];
}

/** 连接级业务规则（业务术语 + 默认业务规则）快照；saved=true 表示刚保存成功（弹层据此关闭/提示）。 */
/** 模型接入快照（自带 Key 模式配置 + 厂商目录 + 同步项勾选；**永不携带 apiKey 值**，只带 hasKey）。 */
export interface AiModelAccessDown {
  type: 'modelAccess';
  mode: 'server-proxy' | 'openai-compatible';
  vendorId: string;
  baseUrl: string;
  model: string;
  customVendors: Array<{ id: string; name: string; baseUrl: string; models: string[] }>;
  customModels: Record<string, string[]>;
  hasKey: boolean;
  prefs: { selection: boolean; custom: boolean; key: boolean };
  catalog: Array<{
    code: string;
    name: { en: string; zh: string };
    baseUrl: string;
    models: Array<{ id: string; label?: string; default?: boolean }>;
    sortOrder: number;
  }>;
  /** 保存校验失败错误码（仅保存回执时出现；UI 本地化）。 */
  saveError?: string;
}

/** 连接测试结果（稳定原因码 + 耗时；不含密钥）。 */
export interface AiModelAccessTestDown {
  type: 'modelAccessTest';
  result: { ok: boolean; code: string; latencyMs: number; status?: number; detail?: string };
}

export interface AiBusinessRulesDown {
  type: 'businessRules';
  connId?: string;
  domainContext: string;
  defaultDirectives: string;
  saved?: boolean;
}

export interface AiTableOptionsDown {
  type: 'tableOptions';
  tables: string[];
  /** 列表对应作用域（响应乱序保护）。 */
  scope?: string;
}

export interface AiTableNoteDown {
  type: 'tableNote';
  table: string;
  note?: string;
  /** 注记记录最后修改时间（同步实体 updateTime；无注记时缺省）。 */
  updatedAt?: number;
  columns: Array<{ name: string; type: string; comment?: string; note?: string; sample?: string }>;
}

export interface AiColumnSampleDown {
  type: 'columnSample';
  table: string;
  column: string;
  values?: string[];
  error?: string;
}

export interface AiToolResultDown {
  type: 'toolResult';
  title: string;
  content: string;
  isError?: boolean;
  /** 回帖渲染：缺省 = 围栏代码块（`lang` 缺省为空）；markdown = 直接拼 Markdown 文本（如 SQL 结果表格）。 */
  format?: 'text' | 'markdown';
  /** 围栏语言标记（redis-result / es-result 等）；仅 format=text 时有意义。 */
  lang?: string;
  /** 结果内联回填引用（P9）：来自上行 executeSqlInChat/autoExecuteSql/runRedis/runEsDsl 的透传。 */
  blockRef?: AiBlockRef;
  /** 对应 toolRunning 的执行标识（SQL in-chat；结束执行中指示）。 */
  runId?: string;
  /** 实测执行耗时（ms；SQL in-chat）。 */
  costMs?: number;
  /** 用户取消或确认门禁未放行（未产生执行结果）。 */
  canceled?: boolean;
}

/** SQL in-chat 开始执行（webview 据此显示「执行中 + 计时 + 取消」；toolResult 到达即结束）。 */
export interface AiToolRunningDown {
  type: 'toolRunning';
  runId: string;
  /** host 端开始时间戳（ms）。 */
  startedAt: number;
  blockRef: AiBlockRef;
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
  | AiContextDetailDown
  | AiBusinessRulesDown
  | AiModelAccessDown
  | AiModelAccessTestDown
  | AiToolResultDown
  | AiToolRunningDown
  | AiTableOptionsDown
  | AiTableNoteDown
  | AiColumnSampleDown;

// ── Up（webview → host）──

export interface AiSaveModelAccessUp {
  type: 'saveModelAccess';
  mode: 'server-proxy' | 'openai-compatible';
  vendorId: string;
  baseUrl: string;
  model: string;
  customVendors: Array<{ id: string; name: string; baseUrl: string; models: string[] }>;
  customModels: Record<string, string[]>;
  /** 新填写的 Key（空 = 保持本机）——**仅此上行与 testModelAccess 允许携带密钥**。 */
  apiKey: string;
  clearKey?: boolean;
  prefs: { selection: boolean; custom: boolean; key: boolean };
}

/** 测试连接（不保存）：apiKey 为待测新 Key（空 = 用已保存的）。 */
export interface AiTestModelAccessUp {
  type: 'testModelAccess';
  baseUrl: string;
  model: string;
  apiKey: string;
}

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

/** S7b：执行 AI 生成的 Redis 命令（代码块按钮，用户显式触发）。 */
export interface AiRunRedisUp {
  type: 'runRedis';
  text: string;
  /** 结果内联绑定（P9）：webview 生成、host 透传。 */
  blockRef?: AiBlockRef;
}

/** S7c：执行 AI 生成的 ES DSL（代码块按钮，用户显式触发）。 */
export interface AiRunEsDslUp {
  type: 'runEsDsl';
  text: string;
  /** 结果内联绑定（P9）：webview 生成、host 透传。 */
  blockRef?: AiBlockRef;
}

/** 表选择：拉取当前作用域的表清单（抽屉打开时）。 */
export interface AiRequestTableOptionsUp {
  type: 'requestTableOptions';
}

/** 表选择：应用勾选（空数组 = 恢复自动模式）。 */
export interface AiSelectTablesUp {
  type: 'selectTables';
  tables: string[];
}

/** S7e：拉取某表的列元数据 + 现有注记（打开说明编辑器）。 */
export interface AiRequestTableNoteUp {
  type: 'requestTableNote';
  table: string;
}

/** S7e：保存某表的注记（整表覆盖式；空内容即删除）。 */
export interface AiSaveTableNoteUp {
  type: 'saveTableNote';
  table: string;
  note?: string;
  columns: Array<{ name: string; note?: string; sample?: string }>;
}

/** S7e：抓取某列样例值（用户点击；只读 LIMIT 10；敏感列拒绝）。 */
export interface AiFetchColumnSampleUp {
  type: 'fetchColumnSample';
  table: string;
  column: string;
}

/**
 * 结果内联绑定引用（P9）：webview 生成（消息下标 + 块下标 + 代次），host 在
 * toolResult 下行里原样回带；host 不解释其语义。gen 为 webview 消息代次
 * （会话切换/重置时 +1，迟到的旧代次结果回退尾部气泡）。
 */
export interface AiBlockRef {
  gen: number;
  msgIdx: number;
  blockIdx: number;
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
  | AiRunRedisUp
  | AiRunEsDslUp
  | AiRequestTableOptionsUp
  | AiSelectTablesUp
  | AiRequestTableNoteUp
  | AiSaveTableNoteUp
  | AiFetchColumnSampleUp
  | { type: 'requestQuotaRefresh' }
  | { type: 'openConsole'; path: string }
  | { type: 'openSettings' }
  | { type: 'setApiKey' }
  | { type: 'clearApiKey' }
  | { type: 'testConnection' }
  | { type: 'copyCode'; text: string }
  | { type: 'applyCode'; text: string }
  | { type: 'executeSql'; text: string }
  | { type: 'executeSqlInChat'; text: string; blockRef?: AiBlockRef }
  | { type: 'autoExecuteSql'; text: string; blockRef?: AiBlockRef }
  | { type: 'runRedisInPanel'; text: string }
  | { type: 'runEsDslInPanel'; text: string }
  | { type: 'requestContextDetail' }
  | { type: 'cancelQuery'; runId: string }
  | { type: 'optimizeSql'; text: string; costMs?: number }
  | { type: 'requestModelAccess' }
  | AiSaveModelAccessUp
  | AiTestModelAccessUp
  | { type: 'requestBusinessRules' }
  | { type: 'saveBusinessRules'; domainContext: string; defaultDirectives: string };

/** 会话消息类型在协议层再导出，webview 侧从 ai-protocol 单点取。 */
export type { AiChatMessage, AiChatSession };