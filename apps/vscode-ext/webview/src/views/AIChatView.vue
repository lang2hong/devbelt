<script setup lang="ts">
import { provide, computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { setLanguage, useI18n } from '../composables/useI18n';
import MessageList from '../components/ai/MessageList.vue';
import ChatInput from '../components/ai/ChatInput.vue';
import ConversationDrawer from '../components/ai/ConversationDrawer.vue';
import ContextBar from '../components/ai/ContextBar.vue';
import ContextDetailDrawer, { type ContextDetailState } from '../components/ai/ContextDetailDrawer.vue';
import TableNoteDialog, { type TableNoteColumn } from '../components/ai/TableNoteDialog.vue';
import TableScopeDialog from '../components/ai/TableScopeDialog.vue';
import BusinessRulesDialog from '../components/ai/BusinessRulesDialog.vue';
import ModelAccessDialog from '../components/ai/ModelAccessDialog.vue';
import type { CatalogProvider, CustomVendor, ModelAccessSyncPrefs, ModelAccessTestResult } from '../../../src/ai/modelAccess';
import { summarizeBusinessRules } from '../../../src/ai/businessRules';

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 推理模型的思考过程（可折叠展示；本地会话回看）。 */
  reasoning?: string;
  error?: boolean;
  /** 代码块下标 → 内联执行结果（P9：blockRef 绑定；瞬态，不进会话存储）。 */
  blockResults?: Record<number, AiToolResultPayload>;
  /** 代码块下标 → 执行中指示（toolRunning；toolResult 到达即清除；瞬态）。 */
  blockRunning?: Record<number, AiRunningPayload>;
}

/**
 * AI Chat 根视图（P9 S3）：独立入口 `aiChat.html`（不走 App.vue mode switch）。
 *
 * 消息协议见 `src/result/aiProtocol.ts`：
 *   up: ready | send | abort | newChat | renameChat | deleteChat | loadHistory |
 *       selectConnection | selectScope | requestTableOptions | selectTables | requestTableNote |
 *       saveTableNote | fetchColumnSample | requestQuotaRefresh | openSettings | setApiKey |
 *       clearApiKey | testConnection | copyCode
 *   down: init | chunk | finish | quotaUpdate | contextChanged | sessionList | sessionLoaded |
 *         contextDetail | prefillInput | toolResult | tableOptions | tableNote | columnSample
 */
const { post, onMessage } = useVsCode();
const { t } = useI18n();

/** in-chat 执行统一派发：在此补齐消息代次（blockRef 守卫的必要字段）。 */
provide(RUN_IN_CHAT_KEY, (payload: RunInChatPayload) => {
  const blockRef = payload.msgIdx !== undefined && payload.blockIdx !== undefined
    ? { gen: messageGeneration, msgIdx: payload.msgIdx, blockIdx: payload.blockIdx }
    : undefined;
  const type = payload.kind === 'sql' ? 'executeSqlInChat' : payload.kind === 'redis' ? 'runRedis' : 'runEsDsl';
  post({ type, text: payload.text, ...(blockRef ? { blockRef } : {}) });
});

import { autoExecutableSqlBlocks, formatToolResultContent, isForeignSession, type AiRunningPayload, type AiToolResultPayload } from '../utils/aiChatStream';
import { hasChartIntent } from '../utils/chartInference';
import { OPTIMIZE_SQL_KEY, RUN_IN_CHAT_KEY, type RunInChatPayload } from '../utils/runInChat';
import { formatElapsed } from '../../../src/ai/slowQuery';

/**
 * 消息代次（blockRef 守卫）：会话切换/新会话/重置消息时 +1。迟到的 toolResult 若
 * 带着旧代次 blockRef，目标下标已不可信 → 回退尾部气泡，绝不内联回填错消息。
 */
let messageGeneration = 0;
function resetMessages(next: ChatMessage[]): void {
  messageGeneration += 1;
  messages.value = next;
}

/** AI 回复中的只读 SQL 自动执行（宿主分类门禁：仅 SELECT；写/DDL 维持手动按钮）。 */
function autoRunSqlBlocks(content: string): void {
  if (!selectedConnId.value) return;
  const msgIdx = messages.value.length - 1;
  const gen = messageGeneration;
  for (const ref of autoExecutableSqlBlocks(content)) {
    post({ type: 'autoExecuteSql', text: ref.content, blockRef: { gen, msgIdx, blockIdx: ref.blockIdx } });
  }
}

/** 「让 AI 优化」派发：追加用户消息、进入生成态并上行（host 在当前会话 EXPLAIN + optimize）。 */
let skipAutoRunOnce = false;
provide(OPTIMIZE_SQL_KEY, (rawSql: string, costMs?: number) => {
  if (streaming.value !== null) return;
  const sql = rawSql.trim();
  if (!sql) return;
  const prefix = t('ai.optimize.userPrefix', { sec: formatElapsed(costMs ?? 0) });
  messages.value.push({ role: 'user', content: `${prefix}\n\`\`\`sql\n${sql}\n\`\`\`` });
  streaming.value = { content: '', reasoning: '' };
  skipAutoRunOnce = true;
  post({ type: 'optimizeSql', text: sql, ...(costMs !== undefined ? { costMs } : {}) });
});

const provider = ref<any>(null);
const quota = ref<any>(null);
const context = ref<any>(null);
const connections = ref<{ id: string; name: string }[]>([]);
const sessions = ref<SessionSummary[]>([]);
const activeSessionId = ref<string | undefined>(undefined);
const messages = ref<ChatMessage[]>([]);
const streaming = ref<{ content: string; reasoning: string } | null>(null);
const selectedConnId = ref<string | undefined>(undefined);
const input = ref('');
const includeColumnComments = ref(true);
const autoRunReadOnlySql = ref(true);
const editingIndex = ref<number | null>(null);
const suggestions = computed(() => [
  t('wv.ai.suggest.explain'),
  t('wv.ai.suggest.optimize'),
  t('wv.ai.suggest.design'),
  t('wv.ai.suggest.diagnose'),
]);
/**
 * 侧栏折叠视图组（VSCode 侧栏风格：上下堆叠、各自 ▸/▾，可同时展开）：
 * 注入的表（点表名打开说明弹层）/ 会话记录。
 */
const sidebarOpen = reactive({ context: false, rules: false, sessions: true });
function toggleSection(key: keyof typeof sidebarOpen): void {
  sidebarOpen[key] = !sidebarOpen[key];
  if (key === 'context' && sidebarOpen.context) requestContextDetailIfNeeded();
}
/** P9 S4/S7g：「实际注入的表」清单（只读快照；点表名进编辑器）。 */
const contextDetail = ref<ContextDetailState | null>(null);
let contextDetailPending = false;
function requestContextDetailIfNeeded(): void {
  if (contextDetailPending || contextDetail.value) return;
  contextDetailPending = true;
  post({ type: 'requestContextDetail' });
}
/** 方案 A：注入范围弹层（选择表能力收敛为弹层，不占侧栏视图）。 */
const showScopeDialog = ref(false);
const tableOptions = ref<string[]>([]);
const tableOptionsLoading = ref(false);
/** S7h：表/列说明弹层。 */
const showNoteDialog = ref(false);
const tableNoteTable = ref('');
const tableNoteData = ref<{ note?: string; updatedAt?: number; columns: TableNoteColumn[] } | null>(null);
const tableNoteLoading = ref(false);
const samplingColumn = ref<string | null>(null);
const sampleErrors = ref<Record<string, string>>({});
const sampleFill = ref<{ column: string; text: string; seq: number } | null>(null);
let sampleSeq = 0;

/** 连接级业务规则（业务术语 + 默认业务规则；UI 合并，host 侧存储/提示词分离）。 */
const businessRules = ref({ domainContext: '', defaultDirectives: '' });
const showRulesDialog = ref(false);
/** 模型接入（自带 Key/服务端代理）：快照 + 弹层 + 测试结果（Key 值永不下行）。 */
const modelAccess = ref<{
  mode: 'server-proxy' | 'openai-compatible';
  vendorId: string;
  baseUrl: string;
  model: string;
  customVendors: CustomVendor[];
  customModels: Record<string, string[]>;
  hasKey: boolean;
  prefs: ModelAccessSyncPrefs;
  catalog: CatalogProvider[];
  saveError?: string;
}>({ mode: 'server-proxy', vendorId: '', baseUrl: '', model: '', customVendors: [], customModels: {}, hasKey: false, prefs: { selection: true, custom: true, key: true }, catalog: [] });
const showModelAccessDialog = ref(false);
const maTestResult = ref<ModelAccessTestResult | null>(null);
const maTesting = ref(false);
let savingModelAccess = false;
function openModelAccess(): void {
  post({ type: 'requestModelAccess' });
  showModelAccessDialog.value = true;
}
function saveModelAccess(payload: {
  mode: 'server-proxy' | 'openai-compatible';
  vendorId: string;
  baseUrl: string;
  model: string;
  customVendors: CustomVendor[];
  customModels: Record<string, string[]>;
  apiKey: string;
  clearKey: boolean;
  prefs: ModelAccessSyncPrefs;
}): void {
  savingModelAccess = true;
  post({ type: 'saveModelAccess', ...payload });
}
function testModelAccess(payload: { baseUrl: string; model: string; apiKey: string }): void {
  maTesting.value = true;
  maTestResult.value = null;
  post({ type: 'testModelAccess', ...payload });
}
const rulesSummary = computed(() => summarizeBusinessRules(businessRules.value.domainContext, businessRules.value.defaultDirectives));
const rulesConnName = computed(() => connections.value.find((c) => c.id === selectedConnId.value)?.name);
function openRulesDialog(): void {
  if (!selectedConnId.value) return;
  post({ type: 'requestBusinessRules' });
  showRulesDialog.value = true;
}
function saveBusinessRules(payload: { domainContext: string; defaultDirectives: string }): void {
  post({ type: 'saveBusinessRules', ...payload });
}

const generating = computed(() => streaming.value !== null);

let cleanup: (() => void) | undefined;

onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'init':
        setLanguage(!!msg.isZh);
        provider.value = msg.provider ?? null;
        quota.value = msg.quota ?? null;
        context.value = msg.context ?? null;
        connections.value = Array.isArray(msg.connections) ? msg.connections : [];
        sessions.value = Array.isArray(msg.sessions) ? msg.sessions : [];
        includeColumnComments.value = !!msg.includeColumnComments;
        autoRunReadOnlySql.value = msg.autoRunReadOnlySql !== false;
        activeSessionId.value = msg.activeSessionId || undefined;
        selectedConnId.value = msg.context?.connId;
        editingIndex.value = null;
        if (!msg.activeSessionId) resetMessages([]);
        post({ type: 'requestBusinessRules' });
        break;
      case 'sessionLoaded': {
        const session = msg.session;
        if (!session || !session.id) {
          resetMessages([]);
          activeSessionId.value = undefined;
          break;
        }
        activeSessionId.value = session.id;
        resetMessages(Array.isArray(session.messages) ? [...session.messages] : []);
        streaming.value = null;
        editingIndex.value = null;
        if (session.connId) selectedConnId.value = session.connId;
        break;
      }
      case 'sessionList':
        sessions.value = Array.isArray(msg.sessions) ? msg.sessions : [];
        if (msg.activeSessionId !== undefined) activeSessionId.value = msg.activeSessionId || undefined;
        break;
      case 'chunk':
        // 生成中切走会话：旧会话分片不得流进当前视图。
        if (isForeignSession(activeSessionId.value, msg.sessionId)) break;
        if (!streaming.value) streaming.value = { content: '', reasoning: '' };
        if (msg.reasoning) streaming.value.reasoning += msg.reasoning;
        streaming.value.content += msg.delta ?? '';
        break;
      case 'finish': {
        if (isForeignSession(activeSessionId.value, msg.sessionId)) break;
        // host 传权威最终版（保留字补引后的 ```sql 块）时以它为准替换流式缓冲，
        // 保证显示 = 落库 = 自动执行 = 插入编辑器四者一致。
        const content = typeof msg.content === 'string' ? msg.content : (streaming.value?.content ?? '');
        const reasoning = streaming.value?.reasoning ?? '';
        streaming.value = null;
        if (content || reasoning) messages.value.push({ role: 'assistant', content, ...(reasoning ? { reasoning } : {}) });
        if (msg.error) messages.value.push({ role: 'assistant', content: msg.error.message, error: true });
        // 自动执行仅限正常完成：Stop 中断（aborted）后的半截/完整 SQL 不跑，
        // 用户中断即表达「不要继续」，自动执行与之相悖。
        // 「让 AI 优化」的回复不自动执行（优化后的查询可能同样很慢，避免无人值守反复重跑）。
        const skipAutoRun = skipAutoRunOnce;
        skipAutoRunOnce = false;
        if (content && !msg.error && !msg.aborted && !skipAutoRun) autoRunSqlBlocks(content);
        break;
      }
      case 'modelAccess': {
        modelAccess.value = {
          mode: msg.mode === 'openai-compatible' ? 'openai-compatible' : 'server-proxy',
          vendorId: String(msg.vendorId ?? ''),
          baseUrl: String(msg.baseUrl ?? ''),
          model: String(msg.model ?? ''),
          customVendors: Array.isArray(msg.customVendors) ? msg.customVendors : [],
          customModels: (msg.customModels && typeof msg.customModels === 'object') ? msg.customModels : {},
          hasKey: !!msg.hasKey,
          prefs: {
            selection: msg.prefs?.selection !== false,
            custom: msg.prefs?.custom !== false,
            key: msg.prefs?.key !== false,
          },
          catalog: Array.isArray(msg.catalog) ? msg.catalog : [],
          ...(msg.saveError ? { saveError: String(msg.saveError) } : {}),
        };
        // 保存回执：成功关弹层；失败保留并显示错误码。
        if (savingModelAccess) {
          savingModelAccess = false;
          if (!msg.saveError) showModelAccessDialog.value = false;
        }
        break;
      }
      case 'modelAccessTest':
        maTesting.value = false;
        maTestResult.value = (msg.result && typeof msg.result === 'object') ? msg.result : null;
        break;
      case 'businessRules':
        businessRules.value = {
          domainContext: String(msg.domainContext ?? ''),
          defaultDirectives: String(msg.defaultDirectives ?? ''),
        };
        if (msg.saved) showRulesDialog.value = false;
        break;
      case 'quotaUpdate':
        // 刷新失败（null）时保留旧值，避免界面闪成"未登录"。
        if (msg.quota) quota.value = msg.quota;
        break;
      case 'contextChanged': {
        const nextConnId = String(msg.context?.connId ?? '');
        const prevConnId = String(context.value?.connId ?? '');
        context.value = msg.context ?? null;
        if (nextConnId !== prevConnId) {
          contextDetail.value = null;
          contextDetailPending = false;
        }
        break;
      }
      case 'contextDetail':
        contextDetailPending = false;
        if (msg.error) {
          contextDetail.value = null;
          break;
        }
        contextDetail.value = {
          commentCount: Number(msg.context?.commentCount ?? 0),
          tableCount: Number(msg.context?.tableCount ?? 0),
          totalTables: Number(msg.context?.totalTables ?? 0),
          tables: Array.isArray(msg.tables) ? msg.tables : [],
        };
        sidebarOpen.context = true;
        break;
      case 'prefillInput':
        if (typeof msg.text === 'string') input.value = msg.text;
        break;
      case 'tableOptions':
        tableOptions.value = Array.isArray(msg.tables) ? msg.tables : [];
        tableOptionsLoading.value = false;
        if (showScopeDialog.value && msg.scope !== undefined && context.value?.scope && msg.scope !== context.value.scope) {
          // 响应跨作用域（用户已切库）→ 丢弃，等新一轮
          tableOptions.value = [];
        }
        break;
      case 'tableNote':
        tableNoteTable.value = String(msg.table ?? '');
        tableNoteData.value = {
          ...(typeof msg.note === 'string' && msg.note ? { note: msg.note } : {}),
          ...(typeof msg.updatedAt === 'number' ? { updatedAt: msg.updatedAt } : {}),
          columns: Array.isArray(msg.columns) ? msg.columns : [],
        };
        tableNoteLoading.value = false;
        samplingColumn.value = null;
        break;
      case 'columnSample': {
        const column = String(msg.column ?? '');
        samplingColumn.value = null;
        if (Array.isArray(msg.values)) {
          sampleErrors.value = { ...sampleErrors.value, [column]: '' };
          sampleSeq += 1;
          sampleFill.value = { column, text: msg.values.join(', '), seq: sampleSeq };
        } else if (msg.error) {
          sampleErrors.value = { ...sampleErrors.value, [column]: String(msg.error) };
        }
        break;
      }
      case 'toolRunning': {
        // 与 toolResult 同一套 blockRef 校验（代次一致、目标仍是 assistant 消息）。
        const ref = msg.blockRef as { gen?: number; msgIdx?: number; blockIdx?: number } | undefined;
        const target = ref && ref.msgIdx !== undefined && (ref.gen ?? -1) === messageGeneration
          ? messages.value[ref.msgIdx]
          : undefined;
        if (ref && target && target.role === 'assistant' && !target.error && ref.blockIdx !== undefined) {
          (target.blockRunning ??= {})[ref.blockIdx] = { runId: String(msg.runId ?? ''), startedAt: Number(msg.startedAt ?? Date.now()) };
        }
        break;
      }
      case 'toolResult': {
        // 带 blockRef（且代次一致、目标仍是本会话 assistant 消息）→ 结果内联回填到代码块下方；
        // 其余（旧路径/迟到的跨会话结果）→ 维持尾部气泡。
        const ref = msg.blockRef as { gen?: number; msgIdx?: number; blockIdx?: number } | undefined;
        const target = ref && ref.msgIdx !== undefined && (ref.gen ?? -1) === messageGeneration
          ? messages.value[ref.msgIdx]
          : undefined;
        if (ref && target && target.role === 'assistant' && !target.error && ref.blockIdx !== undefined) {
          // 路径 A：本轮最后一条用户消息命中图表意图 → 该轮结果默认以图表呈现。
          const lastUser = [...messages.value].reverse().find((m) => m.role === 'user');
          if (target.blockRunning) delete target.blockRunning[ref.blockIdx];
          (target.blockResults ??= {})[ref.blockIdx] = {
            title: msg.title,
            content: msg.content,
            lang: msg.lang,
            format: msg.format,
            isError: msg.isError,
            costMs: typeof msg.costMs === 'number' ? msg.costMs : undefined,
            canceled: !!msg.canceled,
            preferChart: !!lastUser && hasChartIntent(lastUser.content),
          };
          break;
        }
        const formatted = formatToolResultContent(msg as AiToolResultPayload);
        messages.value.push({ role: 'assistant', content: formatted.content, error: formatted.error });
        break;
      }
      default:
        break;
    }
  });
  post({ type: 'ready' });
});

// 积分自动刷新：面板重新可见 / 窗口聚焦 / 可见时每 60s。
function refreshQuota(): void {
  post({ type: 'requestQuotaRefresh' });
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshQuota();
}
function onWindowFocus(): void {
  refreshQuota();
}
document.addEventListener('visibilitychange', onVisibilityChange);
window.addEventListener('focus', onWindowFocus);
const quotaTimer = window.setInterval(() => {
  if (document.visibilityState === 'visible') refreshQuota();
}, 60_000);

onUnmounted(() => {
  cleanup?.();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('focus', onWindowFocus);
  window.clearInterval(quotaTimer);
});

function send(): void {
  const text = input.value.trim();
  if (!text || generating.value) return;
  const editIndex = editingIndex.value;
  if (editIndex !== null) {
    // 编辑旧用户消息：本地从该条起截断，宿主同步截断后重发。
    messages.value = messages.value.slice(0, editIndex);
    messages.value.push({ role: 'user', content: text });
    streaming.value = { content: '', reasoning: '' };
    post({ type: 'editAndResend', sessionId: activeSessionId.value ?? '', messageIndex: editIndex, text });
    editingIndex.value = null;
    input.value = '';
    return;
  }
  messages.value.push({ role: 'user', content: text });
  streaming.value = { content: '', reasoning: '' };
  post({ type: 'send', sessionId: activeSessionId.value ?? '', text });
  input.value = '';
}

/** 重新生成最后一条 assistant（失败消息即重试）。 */
function regenerate(): void {
  if (generating.value) return;
  let lastAssistant = -1;
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i]!.role === 'assistant') { lastAssistant = i; break; }
  }
  if (lastAssistant < 0) return;
  messages.value = messages.value.slice(0, lastAssistant);
  streaming.value = { content: '', reasoning: '' };
  post({ type: 'regenerate', sessionId: activeSessionId.value ?? '' });
}

function editMessage(index: number, text: string): void {
  if (generating.value) return;
  editingIndex.value = index;
  input.value = text;
}

function cancelEdit(): void {
  editingIndex.value = null;
  input.value = '';
}

function stop(): void {
  post({ type: 'abort' });
}

function copyMessage(text: string): void {
  post({ type: 'copyCode', text });
}

function useSuggestion(text: string): void {
  input.value = text;
}

function newChat(): void {
  resetMessages([]);
  streaming.value = null;
  editingIndex.value = null;
  input.value = '';
  post({ type: 'newChat' });
}

function loadSession(id: string): void {
  post({ type: 'loadHistory', sessionId: id });
}

function renameSession(id: string, title: string): void {
  if (title) post({ type: 'renameChat', sessionId: id, title });
}

function deleteSession(id: string): void {
  post({ type: 'deleteChat', sessionId: id });
}

function selectConnection(id: string | null): void {
  selectedConnId.value = id ?? undefined;
  post({ type: 'selectConnection', connId: id });
}

/** 「连接未打开」点击重试：复用 selectConnection 上行（宿主对无会话连接会执行 openConnection）。 */
function reopenConnection(): void {
  if (selectedConnId.value) selectConnection(selectedConnId.value);
}

/** 购买加油包（P9.1c）：跳浏览器控制台购买页（宿主白名单 openConsole）。 */
function buyTopup(): void {
  post({ type: 'openConsole', path: '/db/ai-topup' });
}

/** S7a：切换作用域（库/逻辑库/索引，单选）。 */
function selectScope(value: string): void {
  post({ type: 'selectScope', value });
}

const scopeLabel = computed(() => {
  const count = context.value?.selectedTables?.length ?? 0;
  return count > 0 ? t('wv.ai.tables.scopeCustom', { n: count }) : t('wv.ai.tables.scopeAuto');
});

/** 「实际注入的表」仅对关系引擎有意义（Redis/ES 的上下文不是表；连接未定时默认显示）。 */
const RELATIONAL_DB_TYPES = new Set(['MYSQL', 'PG', 'SQLITE']);
const showTablesSection = computed(() => {
  const dbType = String(context.value?.dbType ?? '').toUpperCase();
  return dbType === '' || RELATIONAL_DB_TYPES.has(dbType);
});

function openScopeDialog(): void {
  showScopeDialog.value = true;
  tableOptions.value = [];
  tableOptionsLoading.value = true;
  post({ type: 'requestTableOptions' });
}

function applyScopeSelection(tables: string[]): void {
  showScopeDialog.value = false;
  post({ type: 'selectTables', tables });
}

/** S7h：打开表/列说明弹层（向 host 拉列元数据 + 现有注记）。 */
function editTableNote(table: string): void {
  showNoteDialog.value = true;
  tableNoteTable.value = table;
  tableNoteData.value = null;
  tableNoteLoading.value = true;
  samplingColumn.value = null;
  sampleErrors.value = {};
  sampleFill.value = null;
  post({ type: 'requestTableNote', table });
}

function saveTableNote(payload: { table: string; note: string; columns: Array<{ name: string; note: string; sample: string }> }): void {
  post({ type: 'saveTableNote', ...payload });
}

function fetchColumnSample(column: string): void {
  samplingColumn.value = column;
  post({ type: 'fetchColumnSample', table: tableNoteTable.value, column });
}

/** P9 S4：打开上下文明细（按需向 host 拉域上下文/默认指令原文 + 注入表清单）。 */
function openContextDetail(): void {
  sidebarOpen.context = true;
  contextDetail.value = null;
  contextDetailPending = true;
  post({ type: 'requestContextDetail' });
}
</script>

<template>
  <div class="ai-root">
    <ContextBar
      :provider="provider"
      :context="context"
      :quota="quota"
      :connections="connections"
      :selected-conn-id="selectedConnId"
      :include-column-comments="includeColumnComments"
      @select-connection="selectConnection"
      @open-connection="reopenConnection"
      @select-scope="selectScope"
      @open-console="buyTopup"
      @open-settings="post({ type: 'openSettings' })"
      @open-model-access="openModelAccess"
      @refresh-quota="refreshQuota"
      @request-context-detail="openContextDetail"
    />
    <div class="ai-toolbar">
      <button class="ai-btn" @click="newChat">{{ t('wv.ai.newChat') }}</button>
      <button class="ai-btn" @click="toggleSection('sessions')">{{ t('wv.ai.sessions') }}</button>
      <button
        class="ai-btn ai-auto-run"
        :class="{ on: autoRunReadOnlySql }"
        :title="t('wv.ai.autoRun.hint')"
        @click="post({ type: 'openSettings' })"
      >{{ autoRunReadOnlySql ? t('wv.ai.autoRun.on') : t('wv.ai.autoRun.off') }}</button>
      <span class="ai-spacer"></span>
      <button v-if="generating" class="ai-btn" @click="stop">{{ t('wv.ai.stop') }}</button>
    </div>
    <div class="ai-body">
      <div class="ai-side">
        <div v-if="showTablesSection" class="ai-side-section">
          <button class="ai-side-head" @click="toggleSection('context')">
            <span class="ai-side-chevron">{{ sidebarOpen.context ? '▾' : '▸' }}</span>
            <span>{{ t('wv.ai.context.tablesTitle') }}</span>
            <span class="ai-side-count">{{ contextDetail?.tableCount ?? context?.tableCount ?? 0 }}</span>
          </button>
          <div v-show="sidebarOpen.context" class="ai-side-content">
            <div v-if="context?.scopeKind === 'database'" class="ai-scope-row">
              <span class="ai-scope-label">{{ t('wv.ai.tables.scopeLabel') }}</span>
              <button class="ai-btn" @click="openScopeDialog">{{ scopeLabel }}</button>
            </div>
            <ContextDetailDrawer :detail="contextDetail" @edit-table="editTableNote" />
          </div>
        </div>
        <div class="ai-side-section">
          <button class="ai-side-head" @click="toggleSection('rules')">
            <span class="ai-side-chevron">{{ sidebarOpen.rules ? '▾' : '▸' }}</span>
            <span>{{ t('wv.ai.rules.title') }}</span>
            <span class="ai-rules-badge" :class="{ on: rulesSummary.configured }">{{ rulesSummary.configured ? t('wv.ai.rules.configured') : t('wv.ai.rules.empty') }}</span>
          </button>
          <div v-show="sidebarOpen.rules" class="ai-side-content">
            <div class="ai-rules-summary">
              {{ rulesSummary.configured ? t('wv.ai.rules.summary', { domain: rulesSummary.domainChars, directives: rulesSummary.directivesChars }) : t('wv.ai.rules.emptyHint') }}
            </div>
            <button
              class="ai-btn"
              :disabled="!selectedConnId"
              :title="selectedConnId ? '' : t('wv.ai.rules.needConnection')"
              @click="openRulesDialog"
            >{{ t('wv.ai.rules.edit') }}</button>
          </div>
        </div>
        <div class="ai-side-section">
          <button class="ai-side-head" @click="toggleSection('sessions')">
            <span class="ai-side-chevron">{{ sidebarOpen.sessions ? '▾' : '▸' }}</span>
            <span>{{ t('wv.ai.sessions') }}</span>
          </button>
          <div v-show="sidebarOpen.sessions" class="ai-side-content">
            <ConversationDrawer
              :sessions="sessions"
              :active-session-id="activeSessionId"
              @new-chat="newChat"
              @load="loadSession"
              @rename="renameSession"
              @delete="deleteSession"
            />
          </div>
        </div>
      </div>
      <div class="ai-main">
        <MessageList
          :messages="messages"
          :streaming="streaming"
          :db-type="context?.dbType"
          :suggestions="suggestions"
          @copy="copyMessage"
          @suggest="useSuggestion"
          @regenerate="regenerate"
          @edit="editMessage"
        />
        <div v-if="editingIndex !== null" class="ai-edit-banner">
          <span>{{ t('wv.ai.editBanner', { n: editingIndex + 1 }) }}</span>
          <button class="ai-btn" @click="cancelEdit">{{ t('wv.ai.cancelEdit') }}</button>
        </div>
        <ChatInput v-model="input" :generating="generating" @send="send" @stop="stop" />
      </div>
    </div>
    <TableNoteDialog
      v-if="showNoteDialog"
      :table="tableNoteTable"
      :note="tableNoteData?.note"
      :updated-at="tableNoteData?.updatedAt"
      :columns="tableNoteData?.columns ?? []"
      :loading="tableNoteLoading"
      :sampling-column="samplingColumn"
      :sample-errors="sampleErrors"
      :sample-fill="sampleFill"
      @close="showNoteDialog = false"
      @save="saveTableNote"
      @fetch-sample="fetchColumnSample"
    />
    <ModelAccessDialog
      v-if="showModelAccessDialog"
      :mode="modelAccess.mode"
      :vendor-id="modelAccess.vendorId"
      :base-url="modelAccess.baseUrl"
      :model="modelAccess.model"
      :custom-vendors="modelAccess.customVendors"
      :custom-models="modelAccess.customModels"
      :has-key="modelAccess.hasKey"
      :prefs="modelAccess.prefs"
      :catalog="modelAccess.catalog"
      :save-error="modelAccess.saveError"
      :test-result="maTestResult"
      :testing="maTesting"
      @close="showModelAccessDialog = false"
      @save="saveModelAccess"
      @test="testModelAccess"
    />
    <BusinessRulesDialog
      v-if="showRulesDialog"
      :domain-context="businessRules.domainContext"
      :default-directives="businessRules.defaultDirectives"
      :conn-name="rulesConnName"
      @close="showRulesDialog = false"
      @save="saveBusinessRules"
    />
    <TableScopeDialog
      v-if="showScopeDialog"
      :tables="tableOptions"
      :selected="context?.selectedTables ?? []"
      :loading="tableOptionsLoading"
      @apply="applyScopeSelection"
      @close="showScopeDialog = false"
    />
  </div>
</template>

<style scoped>
.ai-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
}
.ai-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.ai-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}
.ai-side {
  width: 340px;
  flex: 0 0 auto;
  border-right: 1px solid var(--vscode-panel-border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.ai-side-section {
  border-bottom: 1px solid var(--vscode-panel-border);
  flex: 0 0 auto;
}
.ai-side-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--vscode-foreground);
  font-family: inherit;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.ai-side-head:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
}
.ai-side-chevron {
  width: 12px;
  color: var(--vscode-descriptionForeground);
}
.ai-side-count {
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}
.ai-side-content {
  padding: 2px 8px 8px;
}
.ai-scope-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 4px;
}
.ai-scope-label {
  color: var(--vscode-descriptionForeground);
}
.ai-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-spacer {
  flex: 1;
}
.ai-rules-badge {
  margin-left: auto;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  color: var(--vscode-descriptionForeground);
}
.ai-rules-badge.on {
  color: var(--vscode-testing-iconPassed, #4caf50);
}
.ai-rules-summary {
  margin-bottom: 4px;
  color: var(--vscode-descriptionForeground);
}
.ai-auto-run.on {
  color: var(--vscode-testing-iconPassed, #3fb950);
  border-color: var(--vscode-testing-iconPassed, #3fb950);
}
.ai-edit-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 4px 12px 0;
  padding: 6px 12px;
  border: 1px solid var(--vscode-focusBorder, #007acc);
  border-radius: 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
</style>