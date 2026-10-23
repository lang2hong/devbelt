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
import type { ExplainPlan } from '@devbelt/explain-core';

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
  | 'redis'
  /** P8：Elasticsearch 面板（Cluster / REST 控制台；S3/S4 增更多 tab）。 */
  | 'elasticsearch'
  /** P10：EXPLAIN 计划树面板。 */
  | 'explain'
  /** P10：慢查询分析面板（本地历史聚合）。 */
  | 'slowQueries'
  /** S7k.8：数据体检面板（发现本地与云端不一致 → 用户选择修复）。 */
  | 'syncDoctor';

/** 账户中心标签。 */
export type HubTab = 'account' | 'sync' | 'session' | 'plans' | 'security';

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

// ────────────────────────── P10：EXPLAIN 计划树 ──────────────────────────

/** 结构化解析失败时保留的原始输出。 */
export interface ExplainFallbackView {
  reason: string;
  rows: unknown[];
  text: string;
}

/** P10 S6：一条索引建议（仅建议，从不执行）。 */
export interface IndexSuggestionView {
  table: string;
  columns: string[];
  name: string;
  /** 方言 createIndexSql 生成的 DDL（标识符已校验）。 */
  sql: string;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  risks: string[];
}

/** 已有索引是另一索引的前缀（信息提示）。 */
export interface RedundantIndexView {
  table: string;
  index: string;
  coveredBy: string;
}

/** 一条 EXPLAIN 语句的结果：plan 与 fallback 二选一。 */
export interface ExplainStatementView {
  sql: string;
  plan: ExplainPlan | null;
  fallback?: ExplainFallbackView;
  /** 原始计划超过消息上限被省略（计划树仍完整）。 */
  rawTruncated?: boolean;
  /** 本条语句 EXPLAIN 失败的报错（其余语句的计划照常展示）；有值时 plan 为 null。 */
  error?: string;
  /** 索引建议（仅结构化计划；元数据读取失败时为空数组）。 */
  suggestions?: IndexSuggestionView[];
  redundantIndexes?: RedundantIndexView[];
}

/** webview → Extension Host。 */
export type ExplainUpMessage =
  | { type: 'ready'; __load?: string }
  | { type: 'rerun' }
  | { type: 'copyText'; text: string }
  /** 让 AI 解释计划；index 为当前语句标签（缺省 0）。 */
  | { type: 'aiExplain'; index?: number };

/** Extension Host → webview。 */
export type ExplainDownMessage =
  | (WebviewInitMessage & { mode: 'explain' })
  | { type: 'explainRunning' }
  | { type: 'explainPlan'; statements: ExplainStatementView[] }
  | { type: 'error'; message: string };

// ────────────────────────── P10：慢查询分析 ──────────────────────────

export type SlowQuerySortView = 'total' | 'avg' | 'max' | 'count';
export type SlowQueryRangeView = '24h' | '7d' | '30d' | 'all';

export interface SlowQueryFilterView {
  connectionId?: string;
  range: SlowQueryRangeView;
  keyword: string;
  sort: SlowQuerySortView;
}

export interface SlowQueryGroupView {
  key: string;
  fingerprint: string;
  sampleSql: string;
  connectionId?: string;
  connection: string;
  database?: string;
  /** 连接已被删除：不能打开 SQL 绑定连接 / 执行 EXPLAIN。 */
  missingConnection: boolean;
  count: number;
  failed: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  lastTime: number;
}

/** webview → Extension Host。 */
export type SlowQueryUpMessage =
  | { type: 'ready'; __load?: string }
  | { type: 'slowFilter'; filter: SlowQueryFilterView }
  | { type: 'slowOpenSql'; key: string }
  | { type: 'slowExplain'; key: string };

/** Extension Host → webview。 */
export type SlowQueryDownMessage =
  | (WebviewInitMessage & { mode: 'slowQueries' })
  | {
      type: 'slowSnapshot';
      filter: SlowQueryFilterView;
      groups: SlowQueryGroupView[];
      connections: Array<{ id: string; name: string }>;
      /** 历史总条数与保留上限（让用户知道样本有多大）。 */
      historySize: number;
      historyLimit: number;
      now: number;
    }
  | { type: 'error'; message: string };

// ────────────────────────── S7k.8：同步体检（数据体检）面板 ──────────────────────────
// 与 SyncDoctorView provider / SyncDoctorView.vue 共享的强类型契约。
// 面板只做「发现 → 用户选择」：扩展下发发现列表与冲突列表，用户逐条点按钮，写入全部由用户触发。

/** 体检发现项（展示值已由引擎解析：名字或引用目标显示名）。 */
export interface SyncFindingView {
  id: string;
  kind: 'missing' | 'nameDrift' | 'refDrift' | 'orphanDelete' | 'remoteDeleted' | 'orphanGroup';
  /** 实体类型（视图用 `sync.entity.<type>` 翻译）。 */
  type: string;
  localValue?: string;
  remoteValue?: string;
  /** 引用漂移明细（视图用 `sync.field.<field>` 翻译字段名；remoteMissing=云端目标本机缺失）。 */
  ref?: { field: string; local?: string; remote?: string; remoteMissing?: boolean };
}

/** 真版本冲突项（本地与云端都改过；由用户三选一）。 */
export interface SyncConflictView {
  recordId: string;
  type: string;
  remoteVersion: string;
}

/** webview → Extension Host。 */
export type SyncDoctorUpMessage =
  | { type: 'ready'; __load?: string }
  | { type: 'syncDoctorRefresh' }
  | { type: 'syncDoctorRepair'; ids?: string[]; direction?: 'cloud' | 'local' | 'merge' }
  | { type: 'syncDoctorResolveConflict'; recordId: string; decision: 'local' | 'merge' | 'remote' };

/** Extension Host → webview。 */
export interface SyncDoctorSnapshotMessage extends WebviewMessage {
  type: 'syncDoctorSnapshot';
  checking: boolean;
  /** 会话未解锁：面板显示先解锁提示。 */
  locked?: boolean;
  lastCheckAt?: number;
  findings: SyncFindingView[];
  conflicts: SyncConflictView[];
  incomplete: boolean;
}

/** 修复完成回执：repaired=按云端修复+合并+清理数；pushed=已定向推送到云端的「使用本机/合并」数；pending=入出站但推送失败（留待同步）数。 */
export interface SyncDoctorResultMessage extends WebviewMessage {
  type: 'syncDoctorResult';
  repaired: number;
  failed: number;
  pushed?: number;
  pending?: number;
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
    };
    /** 预填表单（粘贴链接/扫码）：secret 由宿主按此一次性 id 补齐，entry.secret 可为空串。 */
    prefillId?: string }
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
  /** 取消预填表单：宿主立即释放暂存的 prefill secret（不提前释放等于长期驻留明文种子）。 */
  | { type: 'cancelPrefill' }
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
  | { type: 'groupAdded'; id: string }
  | { type: 'tagAdded'; id: string }
  | { type: 'prefillAdd'; prefillId: string; entry: {
      issuer: string; account?: string;
      algorithm: TotpAlgorithm; digits: 6 | 8; period: 30 | 60;
    } }
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
export type RedisPanel = 'keyBrowser' | 'serverStatus' | 'console' | 'slowlog' | 'commandLog' | 'monitor';

/** Extension Host → webview。 */
export type RedisDownMessage =
  | { type: 'init'; mode: 'redis'; isZh: boolean }
  | { type: 'config'; connName: string; host: string; port: number; db: number | null;
      readOnly: boolean; connMode: 'standalone' | 'cluster' | 'sentinel'; panel: RedisPanel;
      commands: string[] }
  | { type: 'info'; info: string }
  | { type: 'slowlog'; entries: RedisSlowlogEntry[] }
  | { type: 'value'; key: string; keyType: string; ttl: number; tooLarge: boolean; size: number | null; data: RedisValueData | null; truncated?: boolean; keyBinary?: boolean; binaryFields?: string[]; more?: RedisMoreToken }
  // items/itemBytes 形状随 kind：list → string[]；zset → [member, score][]（与 value 消息一致）。
  | { type: 'collectionMoreResult'; key: string; kind: RedisCollectionKind; entries?: [string, string][]; entryBytes?: [string, string][]; items?: string[] | [string, string][]; itemBytes?: string[] | [string, string][]; members?: string[]; memberBytes?: string[]; more: RedisMoreToken }
  | { type: 'monitorSample'; metrics: RedisMonitorMetrics }
  | { type: 'keyAction'; action: string; ok: boolean; error: string | null }
  | { type: 'confirmOpRequired'; kind: string; detail: string }
  | { type: 'commandLog'; entry: RedisCommandLogEntry }
  | { type: 'connectionEvent'; event: string; detail: string | null; at: number }
  | { type: 'streamGroupDetail'; key: string; group: string; consumers: Record<string, string>[]; pending: { count: number; minId: string; maxId: string; consumers: [string, string][] }; pendingEntries: RedisPendingEntry[]; pendingTruncated: boolean }
  | { type: 'streamPendingResult'; key: string; group: string; entries: RedisPendingEntry[]; done: boolean }
  | { type: 'streamRangeResult'; key: string; entries: RedisStreamEntry[]; done: boolean }
  | { type: 'commandResult'; id: string; command: string; ok: boolean; result: string; costMs: number; error: string | null }
  | { type: 'confirmRequired'; id: string; command: string }
  | { type: 'error'; message: string };

/** 绑定值数据（按 key 类型）。 */
/** 集合续页 token：hash/set 用 SCAN `cursor`，list/zset 用 `offset`；`done` 为终态。 */
export interface RedisMoreToken {
  cursor?: string;
  offset?: number;
  done: boolean;
}

/** 支持续页的集合类型（stream 有独立的续页通道）。 */
export type RedisCollectionKind = 'hash' | 'list' | 'set' | 'zset';

/** Stage B（3C-1）：集合二进制项的并行 base64 约定（与文本数组同序同长，仅在存在二进制项时携带）。 */
export type RedisBytes = string;

/** Stream 条目（结构与 db-core RedisStreamEntry 一致）。 */
export interface RedisStreamEntry {
  id: string;
  fields: [string, string][];
  /** Stage B：本页存在二进制 field/value 时的并行 base64（与 fields 同序同长）。 */
  fieldBytes?: [string, string][];
}

/** Stream 消费组 pending 条目（XPENDING 明细）。 */
export interface RedisPendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveryCount: number;
}

/** 监控面板单次采样（INFO 解析结果）。 */
export interface RedisMonitorMetrics {
  ts: number;
  version: string;
  role: string;
  uptimeSeconds: number;
  connectedClients: number;
  usedMemory: number;
  usedMemoryHuman: string;
  maxmemory: number;
  fragmentationRatio: number;
  instantaneousOpsPerSec: number;
  instantaneousInputKbps: number;
  instantaneousOutputKbps: number;
  totalCommandsProcessed: number;
  evictedKeys: number;
  expiredKeys: number;
  keyspaceHits: number;
  keyspaceMisses: number;
  /** 命中率 0..1；无读写（hits+misses=0）时为 null。 */
  hitRate: number | null;
  keyspace: { db: string; keys: number; expires: number }[];
}

export type RedisValueData =
  | { kind: 'string'; text: string; base64: string; binary: boolean; bytes: number }
  | { kind: 'hash'; entries: [string, string][]; len: number; entryBytes?: [RedisBytes, RedisBytes][] }
  | { kind: 'list'; items: string[]; len: number; itemBytes?: RedisBytes[] }
  | { kind: 'set'; members: string[]; card: number; memberBytes?: RedisBytes[] }
  | { kind: 'zset'; items: [string, string][]; card: number; itemBytes?: [RedisBytes, string][] }
  | { kind: 'stream'; entries: RedisStreamEntry[]; len: number; groups: Record<string, string>[] };

/** webview → Extension Host。 */
export type RedisUpMessage =
  | { type: 'ready'; __load?: string }
  | { type: 'runCommand'; id: string; line: string }
  | { type: 'confirmDanger'; id: string; accept: boolean }
  | { type: 'refreshInfo' }
  | { type: 'refreshSlowlog' }
  | { type: 'sampleMonitor' }
  // 值 / CRUD（键导航在 explorer 树侧，见 S5-3/C-1）
  | { type: 'selectKey'; key: string }
  | { type: 'load'; key: string }
  | { type: 'saveString'; key: string; value: string }
  | { type: 'saveStringBytes'; key: string; base64: string }
  | { type: 'appendString'; key: string; value: string }
  | { type: 'setTtl'; key: string; seconds: number }
  | { type: 'persistKey'; key: string }
  | { type: 'renameKey'; key: string; newKey: string }
  | { type: 'deleteKeys'; keys: string[] }
  | { type: 'hashSet'; key: string; field: string; value: string; oldField?: string; fieldBase64?: RedisBytes; valueBase64?: RedisBytes }
  | { type: 'hashDel'; key: string; fields: string[]; fieldsBase64?: RedisBytes[] }
  | { type: 'listPush'; key: string; side: 'left' | 'right'; values: string[] }
  | { type: 'listSet'; key: string; index: number; value: string; original: string; valueBase64?: RedisBytes; originalBase64?: RedisBytes }
  | { type: 'listRem'; key: string; index: number; value: string; valueBase64?: RedisBytes }
  | { type: 'listTrim'; key: string; start: number; stop: number }
  | { type: 'listPop'; key: string; side: 'left' | 'right' }
  | { type: 'setAdd'; key: string; members: string[] }
  | { type: 'setRem'; key: string; members: string[]; membersBase64?: RedisBytes[] }
  | { type: 'zsetAdd'; key: string; score: string; member: string; oldMember?: string; memberBase64?: RedisBytes }
  | { type: 'zsetRem'; key: string; members: string[]; membersBase64?: RedisBytes[] }
  // 集合续页（hash/list/set/zset）：token 回显自 value.more / 上一次 collectionMoreResult。
  | { type: 'collectionMore'; key: string; kind: RedisCollectionKind; cursor?: string; offset?: number }
  // Stream（S4）：破坏性操作须 confirmed=true 才执行（host 先回 confirmOpRequired）。
  | { type: 'streamAdd'; key: string; id: string; fields: [string, string][] }
  | { type: 'streamDel'; key: string; ids: string[]; confirmed?: boolean }
  | { type: 'streamTrim'; key: string; maxlen: number; confirmed?: boolean }
  | { type: 'streamGroupCreate'; key: string; group: string; id: string; mkstream: boolean }
  | { type: 'streamGroupDestroy'; key: string; group: string; confirmed?: boolean }
  | { type: 'streamGroupDelConsumer'; key: string; group: string; consumer: string; confirmed?: boolean }
  | { type: 'streamGroupDetail'; key: string; group: string }
  | { type: 'streamPending'; key: string; group: string; start: string }
  | { type: 'streamAck'; key: string; group: string; ids: string[] }
  | { type: 'streamClaim'; key: string; group: string; consumer: string; ids: string[] }
  | { type: 'streamRange'; key: string; start: string };

// ────────────────────────── P8：Elasticsearch 协议（S2） ──────────────────────────
// 与 ElasticsearchView / ElasticsearchView.vue 共享的强类型契约；字段用 null 不用 undefined。

/** ES 面板 tab（S2：Cluster/REST；S3：Indices/Index；S4：Documents/DSL/Nodes/Log）。 */
export type EsPanelTab = 'cluster' | 'rest' | 'indices' | 'index' | 'documents' | 'dsl' | 'nodes' | 'log';

/** 索引摘要（结构化自 `_cat/indices`；字段与 db-core EsIndexSummary 对齐）。 */
export interface EsIndexSummary {
  name: string;
  health: 'green' | 'yellow' | 'red' | null;
  status: string | null;
  primaryShards: number | null;
  replicas: number | null;
  docsCount: string | null;
  storeSize: string | null;
}

/** 索引详情内容（原始 JSON；超限截断）。 */
export interface EsIndexTruncated {
  mapping: boolean;
  settings: boolean;
  aliases: boolean;
  stats: boolean;
}

/** 集群总览数据（原始 JSON 子集，UI 容错渲染）。 */
export interface EsClusterSnapshot {
  version: string | null;
  clusterName: string | null;
  health: Record<string, unknown> | null;
  info: Record<string, unknown> | null;
  /** 索引总数（`_cat/indices` 行数；失败为 null）。 */
  indicesCount: number | null;
}

/** 一条文档命中（source 原始 JSON）。 */
export interface EsDocHit {
  index: string | null;
  id: string;
  score: number | null;
  source: unknown;
  sort: unknown[] | null;
  /** 乐观并发版本（N2：编辑保存经 if_seq_no/if_primary_term 回传）。 */
  seqNo: number | null;
  primaryTerm: number | null;
}

/** mapping 自动提取的字段（点路径 + 类型）。 */
export interface EsFieldInfo {
  path: string;
  type: string;
}

/** `_cat/nodes` 行（归一后）。 */
export interface EsNodeSummary {
  name: string;
  ip: string | null;
  heapPercent: number | null;
  ramPercent: number | null;
  cpu: number | null;
  load1m: number | null;
  role: string | null;
  master: string | null;
}

/** 已保存的 DSL 查询（Memento，per 连接）。 */
export interface SavedEsQueryView {
  id: string;
  name: string;
  index: string;
  body: string;
  at: number;
}

/** ES 请求日志条目（命令日志面板）。 */
export interface EsLogEntryView {
  method: string;
  path: string;
  status: number;
  tookMs: number;
  time: number;
  error?: string;
}

/** 结构性错误（DSL/文档失败时用；rootCause 保留原始 cause 列表的 reason 文本）。 */
export interface EsErrorInfo {
  message: string;
  type: string | null;
  reason: string | null;
  rootCause: string[];
}

/** 扩展 → webview（P8 S2/S3/S4）。 */
export type EsDownMessage =
  | { type: 'esConfig'; connName: string; host: string; port: number; protocol: 'http' | 'https'; pathPrefix: string | null; readOnly: boolean; tab: EsPanelTab; indexName?: string | null; color: string | null }
  | { type: 'esCluster'; snapshot: EsClusterSnapshot }
  | { type: 'esTab'; tab: EsPanelTab; indexName?: string | null }
  | { type: 'esRestResult'; id: string; status: number; tookMs: number; headers: Record<string, string | string[]>; body: unknown; truncated: boolean }
  | { type: 'esConfirmRequired'; id: string; kind: 'dangerous' | 'readonly'; reason: string; detail: string; typedIndexName: string | null }
  | { type: 'esIndices'; items: EsIndexSummary[] }
  | { type: 'esIndexData'; id: string; name: string; mapping: unknown; settings: unknown; aliases: unknown; stats: unknown; truncated: EsIndexTruncated }
  | { type: 'esIndexError'; id: string; name: string; message: string }
  | { type: 'esDocs'; id: string; index: string; hits: EsDocHit[]; total: number | null; searchAfter: unknown[] | null; truncated: boolean; fields: EsFieldInfo[] }
  | { type: 'esDoc'; id: string; index: string; docId: string; found: boolean; source: unknown; seqNo: number | null; primaryTerm: number | null }
  | { type: 'esDocsError'; id: string; index: string; error: EsErrorInfo }
  | { type: 'esDslResult'; id: string; index: string; took: number | null; timedOut: boolean | null; total: number | null; hits: EsDocHit[]; aggregations: unknown; raw: unknown; truncated: boolean; searchAfter: unknown[] | null }
  | { type: 'esDslError'; id: string; index: string; error: EsErrorInfo }
  | { type: 'esBulkDeleteResult'; id: string; index: string; status: number; tookMs: number; deleted: number; failed: number; body: unknown }
  | { type: 'esNodes'; items: EsNodeSummary[] }
  | { type: 'esNodesError'; error: EsErrorInfo }
  | { type: 'esSavedDsl'; items: SavedEsQueryView[] }
  | { type: 'esLog'; items: EsLogEntryView[] }
  | { type: 'esLogEntry'; entry: EsLogEntryView };

/** webview → extension host（P8 S2/S3/S4）。 */
export type EsUpMessage =
  | { type: 'esRefreshCluster' }
  | { type: 'esRest'; id: string; method: string; path: string; body: string | null; confirmedDanger?: boolean; force?: boolean }
  | { type: 'esCancelRest'; id: string }
  | { type: 'esConfirm'; id: string; accept: boolean; typedName?: string | null }
  | { type: 'esLoadIndices' }
  | { type: 'esLoadIndex'; id: string; name: string }
  | { type: 'esLoadDocs'; id: string; index: string; searchAfter: unknown[] | null; size?: number; query?: string | null; queryMode?: 'text' | 'dsl'; defaultOperator?: 'OR' | 'AND' }
  | { type: 'esGetDoc'; id: string; index: string; docId: string }
  | { type: 'esRunDsl'; id: string; index: string; body: string; size?: number; searchAfter?: unknown[] | null }
  | { type: 'esBulkDelete'; id: string; index: string; ids: string[] }
  | { type: 'esLoadNodes' }
  | { type: 'esLoadSavedDsl' }
  | { type: 'esSaveDsl'; name: string; index: string; body: string }
  | { type: 'esDeleteDsl'; id: string }
  | { type: 'esLoadLog' };
