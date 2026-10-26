<script setup lang="ts">
import { provide, computed, onMounted, onUnmounted, ref } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { setLanguage, useI18n } from '../composables/useI18n';
import MessageList from '../components/ai/MessageList.vue';
import ChatInput from '../components/ai/ChatInput.vue';
import ConversationDrawer from '../components/ai/ConversationDrawer.vue';
import ContextBar from '../components/ai/ContextBar.vue';
import SideDrawer from '../components/ai/SideDrawer.vue';
import QuotaPanel from '../components/ai/QuotaPanel.vue';
import MonitorPanel from '../components/ai/MonitorPanel.vue';
import MonitorProposalCard, { type ProposalState } from '../components/ai/MonitorProposalCard.vue';
import type { MonitorDetail, MonitorTaskView } from '../../../src/monitor/monitorBridge';
import { proposalFailureText, type ConditionInput } from '../utils/monitorView';
import type { MoreMenuItem } from '../components/ai/MoreMenu.vue';
import ContextDetailDrawer, { type ContextDetailState } from '../components/ai/ContextDetailDrawer.vue';
import TableNoteDialog, { type TableNoteColumn } from '../components/ai/TableNoteDialog.vue';
import TableScopeDialog from '../components/ai/TableScopeDialog.vue';
import BusinessRulesDialog from '../components/ai/BusinessRulesDialog.vue';
import ModelAccessDialog from '../components/ai/ModelAccessDialog.vue';
import type { CatalogProvider, CustomVendor, ModelAccessSyncPrefs, ModelAccessTestResult } from '../../../src/ai/modelAccess';
import { summarizeBusinessRules } from '../../../src/ai/businessRules';
import type { AiMessageUsage } from '../../../src/ai/aiSessionStore';

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
  /** 本轮积分消耗、耗时与触发时间（随会话历史持久化）。 */
  usage?: AiMessageUsage;
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
import { hasChartIntent, preferredChartType } from '../utils/chartInference';
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
const agentEnabled = ref(false);
const agentSteps = ref<Array<{ index: number; tool: string; status: 'running' | 'ok' | 'error'; summary?: string; durationMs?: number; errorCode?: string }>>([]);
const agentNotice = ref('');
const editingIndex = ref<number | null>(null);
const suggestions = computed(() => [
  t('wv.ai.suggest.explain'),
  t('wv.ai.suggest.optimize'),
  t('wv.ai.suggest.design'),
  t('wv.ai.suggest.diagnose'),
]);
/**
 * 右侧抽屉（一次只开一个）：会话记录 / 注入的表 / 业务规则 / 额度。
 * 默认关闭，对话区占满宽度；入口在顶栏「⋯」。
 */
type DrawerKind = 'sessions' | 'tables' | 'rules' | 'quota' | 'monitor';
const drawer = ref<DrawerKind | null>(null);
/** P13：后台任务（列表 / 详情缓存 / 是否由本窗口执行）与对话内的监控提案卡片。 */
const monitorTasks = ref<MonitorTaskView[]>([]);
const monitorExecuting = ref(true);
const monitorAvailable = ref(false);
const monitorDetails = ref<Record<string, MonitorDetail | null>>({});
const monitorFocusId = ref<string | null>(null);
const proposals = ref<ProposalState[]>([]);
/** 编辑已创建任务的结果（抽屉里的保存反馈）。 */
const editResult = ref<{ id: string; ok: boolean; reason?: string } | null>(null);
function openDrawer(kind: DrawerKind): void {
  drawer.value = kind;
  if (kind === 'monitor') post({ type: 'monitorRequestList' });
  if (kind === 'tables') requestContextDetailIfNeeded();
  if (kind === 'rules' && selectedConnId.value) post({ type: 'requestBusinessRules' });
  if (kind === 'quota') refreshQuota(false);
}
const drawerTitle = computed(() => {
  switch (drawer.value) {
    case 'sessions': return t('wv.ai.sessions');
    case 'tables': return t('wv.ai.context.tablesTitle');
    case 'rules': return t('wv.ai.rules.title');
    case 'quota': return t('wv.ai.quota.title');
    case 'monitor': return t('monitor.list.title');
    default: return '';
  }
});
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
const savingModelAccess = ref(false);
/** 手动积分刷新状态：id 用于忽略自动刷新回执交错。 */
const quotaRefreshing = ref(false);
const quotaFeedback = ref<'ok' | 'failed' | null>(null);
const quotaRequestId = ref<string | null>(null);
let quotaSeq = 0;
let quotaFeedbackTimer: number | undefined;
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
  if (savingModelAccess.value) return;
  savingModelAccess.value = true;
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
        quotaRefreshing.value = false;
        quotaFeedback.value = null;
        context.value = msg.context ?? null;
        connections.value = Array.isArray(msg.connections) ? msg.connections : [];
        sessions.value = Array.isArray(msg.sessions) ? msg.sessions : [];
        agentEnabled.value = msg.agentEnabled === true;
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
          proposals.value = [];
          // 会话被删除/不存在：生成态也要复位，否则输入框一直禁用。
          streaming.value = null;
          break;
        }
        // 切换 / 重载会话：清空卡片，由宿主随后按会话补发。
        proposals.value = [];
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
      case 'agentStep': {
        if (isForeignSession(activeSessionId.value, msg.sessionId)) break;
        const step = msg.step;
        if (!step || typeof step.index !== 'number') break;
        const at = agentSteps.value.findIndex((s) => s.index === step.index);
        const next = {
          index: step.index,
          tool: String(step.tool ?? ''),
          status: step.status === 'running' || step.status === 'error' ? step.status : 'ok' as const,
          ...(typeof step.summary === 'string' ? { summary: step.summary } : {}),
          ...(typeof step.durationMs === 'number' ? { durationMs: step.durationMs } : {}),
          ...(typeof step.errorCode === 'string' ? { errorCode: step.errorCode } : {}),
        };
        if (at >= 0) agentSteps.value[at] = next;
        else agentSteps.value.push(next);
        break;
      }
      case 'finish': {
        if (isForeignSession(activeSessionId.value, msg.sessionId)) break;
        // host 传权威最终版（保留字补引后的 ```sql 块）时以它为准替换流式缓冲，
        // 保证显示 = 落库 = 自动执行 = 插入编辑器四者一致。
        const content = typeof msg.content === 'string' ? msg.content : (streaming.value?.content ?? '');
        const reasoning = streaming.value?.reasoning ?? '';
        const usage = msg.usage && typeof msg.usage === 'object' ? msg.usage as AiMessageUsage : undefined;
        streaming.value = null;
        if (msg.agentDegraded) {
          agentNotice.value = typeof msg.agentDegradedReason === 'string' && msg.agentDegradedReason
            ? t('wv.ai.agent.degradedReason', { reason: msg.agentDegradedReason })
            : t('wv.ai.agent.degraded');
        }
        else if (msg.agentStopReason === 'max_steps') agentNotice.value = t('wv.ai.agent.stop.max_steps');
        else if (msg.agentStopReason === 'max_tool_calls') agentNotice.value = t('wv.ai.agent.stop.max_tool_calls');
        else if (msg.agentStopReason === 'timeout') agentNotice.value = t('wv.ai.agent.stop.timeout');
        if (content || reasoning) messages.value.push({ role: 'assistant', content, ...(reasoning ? { reasoning } : {}), ...(usage ? { usage } : {}) });
        if (msg.error) messages.value.push({ role: 'assistant', content: msg.error.message, error: true, ...(!content && !reasoning && usage ? { usage } : {}) });
        // 自动执行仅限正常完成：Stop 中断（aborted）后的半截/完整 SQL 不跑，
        // 用户中断即表达「不要继续」，自动执行与之相悖。
        // 「让 AI 优化」的回复不自动执行（优化后的查询可能同样很慢，避免无人值守反复重跑）。
        const skipAutoRun = skipAutoRunOnce;
        skipAutoRunOnce = false;
        if (content && !msg.error && !msg.aborted && !skipAutoRun) autoRunSqlBlocks(content);
        break;
      }
      case 'error': {
        // Host 侧未捕获异常的统一兜底：没收到 finish 时也要退出生成态。
        streaming.value = null;
        const message = String(msg.message ?? '');
        if (message) messages.value.push({ role: 'assistant', content: message, error: true });
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
          catalog: Array.isArray(msg.catalog) && msg.catalog.length > 0 ? msg.catalog : modelAccess.value.catalog,
          ...(msg.saveError ? { saveError: String(msg.saveError) } : {}),
        };
        // 保存回执：成功关弹层；失败保留并显示错误码。
        if (savingModelAccess.value) {
          savingModelAccess.value = false;
          if (!msg.saveError) showModelAccessDialog.value = false;
        }
        break;
      }
      case 'providerUpdate':
        provider.value = msg.provider ?? null;
        break;
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
        if (quotaRefreshing.value && typeof msg.requestId === 'string' && msg.requestId === quotaRequestId.value) {
          quotaRefreshing.value = false;
          quotaFeedback.value = msg.ok === false ? 'failed' : 'ok';
          if (quotaFeedbackTimer) window.clearTimeout(quotaFeedbackTimer);
          quotaFeedbackTimer = window.setTimeout(() => { quotaFeedback.value = null; }, 1800);
        }
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
        break;
      case 'prefillInput':
        if (typeof msg.text === 'string') input.value = msg.text;
        break;
      case 'agentModeChanged':
        agentEnabled.value = msg.enabled === true;
        break;
      case 'monitorList':
        monitorAvailable.value = true;
        monitorTasks.value = Array.isArray(msg.tasks) ? msg.tasks : [];
        monitorExecuting.value = msg.executing !== false;
        break;
      case 'monitorDetail':
        if (typeof msg.id === 'string') monitorDetails.value = { ...monitorDetails.value, [msg.id]: msg.detail ?? null };
        break;
      case 'monitorOpen':
        monitorFocusId.value = typeof msg.focusId === 'string' ? msg.focusId : null;
        openDrawer('monitor');
        break;
      case 'monitorProposal':
        if (isForeignSession(activeSessionId.value, msg.sessionId)) break;
        if (msg.proposal && typeof msg.proposal.id === 'string' && !proposals.value.some((p) => p.proposal.id === msg.proposal.id)) {
          if (msg.status === 'discarded') break;
          const status = msg.status === 'created' ? 'created' : 'pending';
          proposals.value = [...proposals.value, { proposal: msg.proposal, status }];
        }
        break;
      case 'monitorEditResult':
        editResult.value = { id: String(msg.id ?? ''), ok: msg.ok === true, ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}) };
        break;
      case 'monitorConfirmResult': {
        const at = proposals.value.findIndex((p) => p.proposal.id === msg.proposalId);
        if (at < 0) break;
        const next = [...proposals.value];
        next[at] = msg.ok
          ? { ...next[at]!, status: 'created' }
          : { ...next[at]!, status: 'failed', error: t('monitor.proposal.failed', { reason: proposalFailureText(t, msg.reason, msg.issues) }) };
        proposals.value = next;
        break;
      }
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
            preferredChart: lastUser ? preferredChartType(lastUser.content) : null,
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

// 积分自动刷新：面板重新可见 / 窗口聚焦 / 可见时每 60s；手动刷新带 loading/回执。
function refreshQuota(manual = true): void {
  const requestId = `q${++quotaSeq}`;
  if (manual) {
    quotaRefreshing.value = true;
    quotaFeedback.value = null;
    quotaRequestId.value = requestId;
  }
  post({ type: 'requestQuotaRefresh', requestId });
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') refreshQuota(false);
}
function onWindowFocus(): void {
  refreshQuota(false);
}
document.addEventListener('visibilitychange', onVisibilityChange);
window.addEventListener('focus', onWindowFocus);
const quotaTimer = window.setInterval(() => {
  if (document.visibilityState === 'visible') refreshQuota(false);
}, 60_000);

onUnmounted(() => {
  cleanup?.();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('focus', onWindowFocus);
  window.clearInterval(quotaTimer);
  if (quotaFeedbackTimer) window.clearTimeout(quotaFeedbackTimer);
});

function send(): void {
  const text = input.value.trim();
  if (!text || generating.value) return;
  agentSteps.value = [];
  agentNotice.value = '';
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
  agentSteps.value = [];
  agentNotice.value = '';
  let lastAssistant = -1;
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i]!.role === 'assistant') { lastAssistant = i; break; }
  }
  if (lastAssistant < 0) return;
  const kept = messages.value.slice(0, lastAssistant);
  // 没有可重发的用户提问（例如由外部入口生成的回复）：不能把仅有的这条回答删掉。
  if (!kept.some((m) => m.role === 'user')) return;
  messages.value = kept;
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
  proposals.value = [];
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

/** 「⋯」菜单：低频功能统一收纳（注入的表在顶栏库选择器之后，不在这里）。 */
const menuItems = computed<MoreMenuItem[]>(() => {
  const usesQuota = provider.value?.mode !== 'openai-compatible';
  const items: MoreMenuItem[] = [
    { id: 'sessions', label: t('wv.ai.sessions'), hint: sessions.value.length ? String(sessions.value.length) : undefined },
  ];
  items.push({
    id: 'rules',
    label: t('wv.ai.rules.title'),
    disabled: !selectedConnId.value,
    hint: rulesSummary.value.configured ? t('wv.ai.rules.configured') : undefined,
  });
  if (monitorAvailable.value) items.push({
    id: 'monitor',
    label: t('monitor.list.title'),
    ...(monitorTasks.value.length ? { hint: String(monitorTasks.value.filter((m) => m.status !== 'paused').length) + '/' + monitorTasks.value.length } : {}),
  });
  if (usesQuota) items.push({ id: 'quota', label: t('wv.ai.quota.title'), separator: true });
  items.push(
    { id: 'modelAccess', label: t('wv.ai.modelAccess'), separator: !usesQuota },
    { id: 'settings', label: t('wv.ai.settings') },
  );
  return items;
});

function onMenu(id: string): void {
  if (id === 'sessions' || id === 'tables' || id === 'rules' || id === 'quota' || id === 'monitor') openDrawer(id);
  else if (id === 'modelAccess') openModelAccess();
  else if (id === 'settings') post({ type: 'openSettings' });
}

function toggleAgent(): void {
  if (!selectedConnId.value) return;
  agentEnabled.value = !agentEnabled.value;
  post({ type: 'setAgentMode', enabled: agentEnabled.value });
}

/** 抽屉内加载会话后关闭抽屉，回到对话。 */
function loadSessionFromDrawer(id: string): void {
  loadSession(id);
  drawer.value = null;
}

function newChatFromDrawer(): void {
  newChat();
  drawer.value = null;
}

function confirmProposal(proposalId: string, intervalMinutes: number, condition: ConditionInput): void {
  proposals.value = proposals.value.map((p) => (p.proposal.id === proposalId ? { ...p, status: 'creating', error: undefined } : p));
  post({
    type: 'monitorConfirm',
    proposalId,
    intervalMinutes,
    condition: { type: condition.type, ...(condition.value !== undefined ? { value: condition.value } : {}) },
  });
}

function discardProposal(proposalId: string): void {
  // 放弃即移除卡片（扩展端同时删掉记录，重新进入会话不再补发）。
  proposals.value = proposals.value.filter((p) => p.proposal.id !== proposalId);
  post({ type: 'monitorDiscard', proposalId });
}

function explainMonitor(id: string, includeRows: boolean): void {
  drawer.value = null;
  post({ type: 'monitorExplain', id, includeRows });
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
      :menu-items="menuItems"
      @select-connection="selectConnection"
      @open-connection="reopenConnection"
      @select-scope="selectScope"
      @new-chat="newChat"
      @menu="onMenu"
      @open-quota="openDrawer('quota')"
      @open-model-access="openModelAccess"
      @open-tables="openDrawer('tables')"
    />
    <div class="ai-body">
      <div class="ai-main">
        <MessageList
          :messages="messages"
          :streaming="streaming"
          :db-type="context?.dbType"
          :suggestions="suggestions"
          :agent-steps="agentSteps"
          @copy="copyMessage"
          @suggest="useSuggestion"
          @regenerate="regenerate"
          @edit="editMessage"
        />
        <div v-if="proposals.length" class="ai-proposals">
          <MonitorProposalCard
            v-for="state in proposals"
            :key="state.proposal.id"
            :state="state"
            @confirm="confirmProposal"
            @discard="discardProposal"
            @open-tasks="openDrawer('monitor')"
          />
        </div>
        <div v-if="agentNotice" class="ai-agent-notice">{{ agentNotice }}</div>
        <div v-if="editingIndex !== null" class="ai-edit-banner">
          <span>{{ t('wv.ai.editBanner', { n: editingIndex + 1 }) }}</span>
          <button class="ai-btn" @click="cancelEdit">{{ t('wv.ai.cancelEdit') }}</button>
        </div>
        <ChatInput
          v-model="input"
          :generating="generating"
          :agent-enabled="agentEnabled"
          :agent-available="!!selectedConnId"
          @send="send"
          @stop="stop"
          @toggle-agent="toggleAgent"
        />
      </div>
    </div>
    <SideDrawer v-if="drawer" :title="drawerTitle" @close="drawer = null">
      <ConversationDrawer
        v-if="drawer === 'sessions'"
        :sessions="sessions"
        :active-session-id="activeSessionId"
        @new-chat="newChatFromDrawer"
        @load="loadSessionFromDrawer"
        @rename="renameSession"
        @delete="deleteSession"
      />
      <template v-else-if="drawer === 'tables'">
        <div v-if="context?.scopeKind === 'database'" class="ai-scope-row">
          <span class="ai-scope-label">{{ t('wv.ai.tables.scopeLabel') }}</span>
          <button class="ai-btn" @click="openScopeDialog">{{ scopeLabel }}</button>
        </div>
        <ContextDetailDrawer :detail="contextDetail" @edit-table="editTableNote" />
      </template>
      <template v-else-if="drawer === 'rules'">
        <p class="ai-rules-summary">
          {{ rulesSummary.configured ? t('wv.ai.rules.summary', { domain: rulesSummary.domainChars, directives: rulesSummary.directivesChars }) : t('wv.ai.rules.emptyHint') }}
        </p>
        <button class="ai-btn" :disabled="!selectedConnId" @click="openRulesDialog">{{ t('wv.ai.rules.edit') }}</button>
      </template>
      <MonitorPanel
        v-else-if="drawer === 'monitor'"
        :tasks="monitorTasks"
        :executing="monitorExecuting"
        :focus-id="monitorFocusId"
        :details="monitorDetails"
        :edit-result="editResult"
        @explain="explainMonitor"
      />
      <QuotaPanel
        v-else-if="drawer === 'quota'"
        :quota="quota"
        :byok="provider?.mode === 'openai-compatible'"
        :refreshing="quotaRefreshing"
        :feedback="quotaFeedback"
        @refresh="refreshQuota()"
        @buy="buyTopup"
      />
    </SideDrawer>
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
      :saving="savingModelAccess"
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
.ai-body {
  flex: 1;
  display: flex;
  overflow: hidden;
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
.ai-rules-summary {
  margin: 0 0 8px;
  color: var(--vscode-descriptionForeground);
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
.ai-proposals {
  padding: 0 14px;
  max-height: 45vh;
  overflow-y: auto;
}
.ai-agent-notice {
  padding: 6px 14px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  border-top: 1px solid var(--vscode-panel-border);
}
</style>