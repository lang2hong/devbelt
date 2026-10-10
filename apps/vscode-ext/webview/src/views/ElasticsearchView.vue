<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import ClusterOverview from '../components/elasticsearch/ClusterOverview.vue';
import RestConsole from '../components/elasticsearch/RestConsole.vue';
import IndicesTable from '../components/elasticsearch/IndicesTable.vue';
import IndexDetail from '../components/elasticsearch/IndexDetail.vue';
import DocumentsTab from '../components/elasticsearch/DocumentsTab.vue';
import DslTab from '../components/elasticsearch/DslTab.vue';
import NodesTab from '../components/elasticsearch/NodesTab.vue';
import LogPanel from '../components/elasticsearch/LogPanel.vue';
import type { EsClusterSnapshot, EsConfirmRequest, EsDocHit, EsErrorInfo, EsFieldInfo, EsIndexSummary, EsLogEntryView, EsNodeSummary, EsPanelTab, SavedEsQueryView } from '../components/elasticsearch/types';
import { shouldAutoLoad } from '../components/elasticsearch/types';

const { post, onMessage } = useVsCode();
const { t } = useI18n();
let off: (() => void) | undefined;

const tab = ref<EsPanelTab>('cluster');
const connName = ref('');
const endpoint = ref('');
const readOnly = ref(false);
const color = ref('');
const snapshot = ref<EsClusterSnapshot | null>(null);
const confirm = ref<EsConfirmRequest | null>(null);
const typedName = ref('');
const running = ref(false);
const result = ref<any>(null);
let lastRequest: { id: string; method: string; path: string; body: string | null } | null = null;

// ── S3：索引列表 / 详情 ──
const indices = ref<EsIndexSummary[] | null>(null);
const indicesError = ref('');
const indexName = ref('');
const indexData = ref<{ mapping: unknown; settings: unknown; aliases: unknown; stats: unknown; truncated: { mapping: boolean; settings: boolean; aliases: boolean; stats: boolean } } | null>(null);
const indexError = ref('');
const opResult = ref<{ status: number; tookMs: number; body: unknown } | null>(null);
/** 索引/文档操作请求 id（ix*）→ method；结果单独展示而非 REST 控制台（仅写请求使用）。 */
const opPending = new Map<string, string>();
let seq = 0;
function nextOpId(): string { seq += 1; return `ix${seq}`; }

// ── S4：文档 ──
const docs = ref<{ hits: EsDocHit[] | null; total: number | null; truncated: boolean; error: EsErrorInfo | null }>({ hits: null, total: null, truncated: false, error: null });
/** S4.5：当前搜索（文本 query_string / DSL body；空 = 浏览全部）、匹配方式与 mapping 字段建议。 */
const docsQuery = ref('');
const docsMode = ref<'text' | 'dsl'>('text');
const docsOperator = ref<'OR' | 'AND'>('OR');
const docsFields = ref<EsFieldInfo[]>([]);
/** 「在 DSL 打开」预填种子（DslTab 消费）。 */
const dslSeed = ref<{ body: string; index: string; at: number } | null>(null);
/** 分页游标栈（当前页 cursor 在 docsCursor；prev 时弹栈）。 */
let docsCursor: unknown[] | null = null;
let docsNext: unknown[] | null = null;
const docsHistory: (unknown[] | null)[] = [];

// ── S4：DSL ──
const dslResult = ref<{ took: number | null; timedOut: boolean | null; total: number | null; hits: EsDocHit[]; aggregations: unknown; raw: unknown; truncated: boolean } | null>(null);
const dslError = ref<EsErrorInfo | null>(null);
const dslRunning = ref(false);
const savedDsl = ref<SavedEsQueryView[]>([]);
let dslSeq = 0;

// ── S4：节点 / 日志 ──
const nodes = ref<EsNodeSummary[] | null>(null);
const nodesError = ref<EsErrorInfo | null>(null);
const logEntries = ref<EsLogEntryView[]>([]);

function switchTab(next: EsPanelTab): void { tab.value = next; }

function send(req: { id: string; method: string; path: string; body: string | null }): void {
  lastRequest = req;
  running.value = true;
  result.value = null;
  post({ type: 'esRest', ...req });
}
function confirmOk(): void {
  const c = confirm.value;
  confirm.value = null;
  if (!c || !lastRequest) return;
  running.value = true;
  post({ type: 'esConfirm', id: c.id, accept: true, typedName: typedName.value });
  typedName.value = '';
}
function confirmCancel(): void {
  const c = confirm.value;
  confirm.value = null;
  typedName.value = '';
  if (!c) return;
  post({ type: 'esConfirm', id: c.id, accept: false });
}
function refreshCluster(): void { post({ type: 'esRefreshCluster' }); }
function requestIndices(): void { indices.value = null; indicesError.value = ''; post({ type: 'esLoadIndices' }); }
function requestIndex(): void {
  if (!indexName.value) return;
  indexData.value = null;
  indexError.value = '';
  post({ type: 'esLoadIndex', id: nextOpId(), name: indexName.value });
}
function openIndex(name: string): void {
  indexName.value = name;
  tab.value = 'index';
}
/** 索引详情操作（open/close/flush/aliases…）：复用 REST 管线（危险/只读确认与审计）。 */
function sendIndexOp(payload: { method: string; path: string; body: string | null }): void {
  opResult.value = null;
  const id = nextOpId();
  opPending.set(id, payload.method.toUpperCase());
  post({ type: 'esRest', id, ...payload });
}

// ── S4 请求方法 ──
function requestDocs(searchAfter: unknown[] | null): void {
  if (!indexName.value) {
    docs.value = { hits: [], total: null, truncated: false, error: null };
    return;
  }
  docs.value = { ...docs.value, hits: null, error: null };
  docsCursor = searchAfter;
  post({
    type: 'esLoadDocs',
    id: nextOpId(),
    index: indexName.value,
    searchAfter,
    query: docsQuery.value.trim() || null,
    queryMode: docsMode.value,
    defaultOperator: docsOperator.value,
  });
}
/** 新搜索/清空：重置游标栈并回到第一页。 */
function searchDocs(payload: { mode: 'text' | 'dsl'; query: string; operator: 'OR' | 'AND' }): void {
  docsMode.value = payload.mode;
  docsQuery.value = payload.query;
  docsOperator.value = payload.operator;
  docsHistory.length = 0;
  docsNext = null;
  requestDocs(null);
}
/** 「在 DSL 打开」：预填 DSL tab 的 index+body 并切换过去。 */
function openDslWith(payload: { body: string }): void {
  dslSeed.value = { body: payload.body, index: indexName.value, at: Date.now() };
  tab.value = 'dsl';
}
/** N1：按 _id 跳转走专用链路（host esGetDoc → esDoc 单命中渲染）。 */
function jumpDoc(payload: { docId: string }): void {
  if (!indexName.value) return;
  post({ type: 'esGetDoc', id: nextOpId(), index: indexName.value, docId: payload.docId });
}
function docsNextPage(): void {
  if (!docsNext) return;
  docsHistory.push(docsCursor);
  requestDocs(docsNext);
}
function docsPrevPage(): void {
  if (!docsHistory.length) return;
  requestDocs(docsHistory.pop()!);
}
function requestNodes(): void { nodes.value = null; nodesError.value = null; post({ type: 'esLoadNodes' }); }
function requestSaved(): void { post({ type: 'esLoadSavedDsl' }); }
function runDsl(payload: { index: string; body: string }): void {
  dslRunning.value = true;
  dslResult.value = null;
  dslError.value = null;
  dslSeq += 1;
  post({ type: 'esRunDsl', id: `dx${dslSeq}`, index: payload.index, body: payload.body });
}
function saveDsl(payload: { name: string; index: string; body: string }): void {
  post({ type: 'esSaveDsl', ...payload });
}
function removeSavedDsl(id: string): void { post({ type: 'esDeleteDsl', id }); }

/** Ctrl+R：刷新当前 tab（DSL 不自动重跑，避免意外查询）。 */
function refreshCurrent(): void {
  if (tab.value === 'cluster') refreshCluster();
  else if (tab.value === 'indices') requestIndices();
  else if (tab.value === 'index') requestIndex();
  else if (tab.value === 'documents') requestDocs(docsCursor);
  else if (tab.value === 'nodes') requestNodes();
  else if (tab.value === 'log') post({ type: 'esLoadLog' });
}
function onKeydown(e: KeyboardEvent): void {
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); refreshCurrent(); }
  else if (k === 'g') { e.preventDefault(); tab.value = 'log'; }
}

/** 换索引：只重置与该索引绑定的数据/搜索状态（组件本地状态因 v-show 常驻而保留）。 */
function resetIndexState(): void {
  indexData.value = null;
  indexError.value = '';
  docsQuery.value = '';
  docsMode.value = 'text';
  docsOperator.value = 'OR';
  docsFields.value = [];
  docsHistory.length = 0;
  docsNext = null;
  docsCursor = null;
  docs.value = { hits: null, total: null, truncated: false, error: null };
  opResult.value = null;
}

/**
 * tab/索引变化：
 *  - 换索引（indexName 变）→ 重置该索引数据；若当前在 index/documents 则强制重拉；
 *  - 仅切 tab → 已有数据不重拉（保留搜索词/翻页/展开/输入现场），缺数据才懒加载；
 *  - dsl/log 每次进入轻量刷新（不触碰组件本地输入）。
 */
watch([tab, indexName], ([nextTab], [, prevIndex]) => {
  const indexChanged = indexName.value !== prevIndex;
  if (indexChanged) resetIndexState();

  if (nextTab === 'dsl') { requestSaved(); return; }
  if (nextTab === 'log') { post({ type: 'esLoadLog' }); return; }

  const force = indexChanged && (nextTab === 'index' || nextTab === 'documents');
  const loaded = {
    indices: indices.value !== null,
    index: indexData.value !== null,
    docs: docs.value.hits !== null,
    nodes: nodes.value !== null,
  };
  if (!force && !shouldAutoLoad(nextTab, loaded)) return;

  if (nextTab === 'indices') requestIndices();
  else if (nextTab === 'index') requestIndex();
  else if (nextTab === 'documents' && indexName.value) requestDocs(null);
  else if (nextTab === 'nodes') requestNodes();
});

onMounted(() => {
  post({ type: 'ready' });
  window.addEventListener('keydown', onKeydown);
  off = onMessage((msg: any) => {
    if (msg.type === 'esConfig') {
      connName.value = msg.connName ?? '';
      endpoint.value = `${msg.protocol}://${msg.host}:${msg.port}${msg.pathPrefix ?? ''}`;
      readOnly.value = !!msg.readOnly;
      color.value = typeof msg.color === 'string' ? msg.color : '';
      if (msg.indexName) indexName.value = msg.indexName;
      tab.value = (msg.tab as EsPanelTab) ?? 'cluster';
    } else if (msg.type === 'esTab') {
      if (msg.indexName) indexName.value = msg.indexName;
      tab.value = (msg.tab as EsPanelTab) ?? 'cluster';
    } else if (msg.type === 'esCluster') {
      snapshot.value = msg.snapshot ?? null;
    } else if (msg.type === 'esIndices') {
      indices.value = msg.items ?? [];
      indicesError.value = '';
    } else if (msg.type === 'esIndexData') {
      indexName.value = msg.name ?? indexName.value;
      indexData.value = { mapping: msg.mapping, settings: msg.settings, aliases: msg.aliases, stats: msg.stats, truncated: msg.truncated ?? { mapping: false, settings: false, aliases: false, stats: false } };
      indexError.value = '';
    } else if (msg.type === 'esIndexError') {
      if (msg.id === 'indices') indicesError.value = msg.message ?? '';
      else indexError.value = msg.message ?? '';
    } else if (msg.type === 'esDocs') {
      docs.value = { hits: msg.hits ?? [], total: msg.total ?? null, truncated: !!msg.truncated, error: null };
      docsNext = msg.searchAfter ?? null;
      docsFields.value = msg.fields ?? [];
    } else if (msg.type === 'esDoc') {
      docsHistory.length = 0;
      docsCursor = null;
      docsNext = null;
      docs.value = msg.found
        ? { hits: [{ index: msg.index, id: msg.docId, score: null, source: msg.source, sort: null, seqNo: msg.seqNo ?? null, primaryTerm: msg.primaryTerm ?? null }], total: 1, truncated: false, error: null }
        : { hits: [], total: null, truncated: false, error: { message: `${msg.docId}: not found`, type: 'not_found', reason: null, rootCause: [] } };
    } else if (msg.type === 'esDocsError') {
      docs.value = { ...docs.value, hits: [], error: msg.error };
    } else if (msg.type === 'esDslResult') {
      dslRunning.value = false;
      dslError.value = null;
      dslResult.value = { took: msg.took ?? null, timedOut: msg.timedOut ?? null, total: msg.total ?? null, hits: msg.hits ?? [], aggregations: msg.aggregations, raw: msg.raw, truncated: !!msg.truncated };
    } else if (msg.type === 'esDslError') {
      dslRunning.value = false;
      dslError.value = msg.error;
    } else if (msg.type === 'esNodes') {
      nodes.value = msg.items ?? [];
      nodesError.value = null;
    } else if (msg.type === 'esNodesError') {
      nodesError.value = msg.error;
    } else if (msg.type === 'esSavedDsl') {
      savedDsl.value = msg.items ?? [];
    } else if (msg.type === 'esLog') {
      logEntries.value = msg.items ?? [];
    } else if (msg.type === 'esLogEntry') {
      logEntries.value = [...logEntries.value, msg.entry].slice(-500);
    } else if (msg.type === 'esRestResult') {
      if (opPending.has(msg.id)) {
        opPending.delete(msg.id);
        opResult.value = { status: msg.status, tookMs: msg.tookMs, body: msg.body };
        // op 通道现仅承载写请求（跳转已改走 esGetDoc）：成功 → 按当前 tab 定向刷新。
        if (msg.status < 300) {
          if (tab.value === 'index') requestIndex();
          else if (tab.value === 'documents') requestDocs(docsCursor);
        }
      } else {
        running.value = false;
        result.value = msg;
      }
    } else if (msg.type === 'esConfirmRequired') {
      running.value = false;
      confirm.value = { id: msg.id, kind: msg.kind, reason: msg.reason, detail: msg.detail, typedIndexName: msg.typedIndexName ?? null };
    } else if (msg.type === 'error') {
      running.value = false;
    }
  });
});
onUnmounted(() => { window.removeEventListener('keydown', onKeydown); off?.(); });

function confirmKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') confirmCancel();
  else if (e.key === 'Enter') confirmOk();
}
</script>

<template>
  <div class="es-view">
    <header class="es-header">
      <span v-if="color" class="es-color-dot" :style="{ background: color }" />
      <span class="es-conn">{{ connName }}</span>
      <span class="es-endpoint">{{ endpoint }}</span>
      <span v-if="readOnly" class="es-ro-badge">{{ t('wv.es.readOnly') }}</span>
    </header>
    <nav class="es-tabs">
      <button class="es-tab" :class="{ active: tab === 'cluster' }" @click="switchTab('cluster')">{{ t('wv.es.tab.cluster') }}</button>
      <button class="es-tab" :class="{ active: tab === 'indices' }" @click="switchTab('indices')">{{ t('wv.es.tab.indices') }}</button>
      <button class="es-tab" :class="{ active: tab === 'index' }" @click="switchTab('index')">{{ t('wv.es.tab.index') }}</button>
      <button class="es-tab" :class="{ active: tab === 'documents' }" @click="switchTab('documents')">{{ t('wv.es.tab.documents') }}</button>
      <button class="es-tab" :class="{ active: tab === 'dsl' }" @click="switchTab('dsl')">{{ t('wv.es.tab.dsl') }}</button>
      <button class="es-tab" :class="{ active: tab === 'nodes' }" @click="switchTab('nodes')">{{ t('wv.es.tab.nodes') }}</button>
      <button class="es-tab" :class="{ active: tab === 'log' }" @click="switchTab('log')">{{ t('wv.es.tab.log') }}</button>
      <button class="es-tab" :class="{ active: tab === 'rest' }" @click="switchTab('rest')">{{ t('wv.es.tab.rest') }}</button>
      <span class="es-spacer" />
      <button v-if="tab === 'cluster'" class="es-refresh" @click="refreshCluster">{{ t('wv.es.refresh') }}</button>
      <button v-else-if="tab === 'indices' || tab === 'index' || tab === 'documents' || tab === 'nodes' || tab === 'log'" class="es-refresh" @click="refreshCurrent">{{ t('wv.es.refresh') }}</button>
    </nav>

    <!-- v-show 常驻挂载：切 tab 保留各组件本地状态（输入/历史/展开/筛选），仅数据按需懒加载。 -->
    <div class="es-body">
    <ClusterOverview v-show="tab === 'cluster'" :snapshot="snapshot" />
    <IndicesTable v-show="tab === 'indices'" :items="indices" :error="indicesError" @refresh="requestIndices" @open="openIndex" />
    <IndexDetail v-show="tab === 'index'" :name="indexName" :mapping="indexData?.mapping" :settings="indexData?.settings" :aliases="indexData?.aliases" :stats="indexData?.stats"
      :truncated="indexData?.truncated ?? { mapping: false, settings: false, aliases: false, stats: false }" :error="indexError" :read-only="readOnly"
      :op-result="opResult" @reload="requestIndex" @op="sendIndexOp" />
    <DocumentsTab v-show="tab === 'documents'" :index="indexName" :hits="docs.hits" :total="docs.total" :truncated="docs.truncated"
      :error="docs.error" :op-result="opResult" :read-only="readOnly" :query="docsQuery" :query-mode="docsMode" :default-operator="docsOperator" :fields="docsFields"
      @load="requestDocs" @search="searchDocs" @open-dsl="openDslWith" @jump="jumpDoc" @next="docsNextPage" @prev="docsPrevPage" @op="sendIndexOp" />
    <DslTab v-show="tab === 'dsl'" :index="indexName" :running="dslRunning" :result="dslResult" :error="dslError" :saved="savedDsl" :seed="dslSeed"
      @run="runDsl" @save="saveDsl" @remove-saved="removeSavedDsl" />
    <NodesTab v-show="tab === 'nodes'" :items="nodes" :error="nodesError" />
    <LogPanel v-show="tab === 'log'" :items="logEntries" />
    <RestConsole v-show="tab === 'rest'" :read-only="readOnly" :running="running" :result="result" @send="send" />
    </div>

    <div v-if="confirm" class="es-modal-backdrop">
      <div class="es-modal" tabindex="-1" @keydown="confirmKeydown">
        <div class="es-modal-title">
          {{ confirm.kind === 'dangerous' ? t('wv.es.confirm.title.dangerous') : t('wv.es.confirm.title.readonly') }}
        </div>
        <div class="es-modal-body">
          <p>{{ confirm.kind === 'dangerous' ? t('wv.es.confirm.dangerous', { detail: confirm.detail }) : t('wv.es.confirm.readonly') }}</p>
          <p v-if="confirm.typedIndexName" class="es-modal-typed">
            {{ t('wv.es.confirm.typed', { name: confirm.typedIndexName }) }}
            <input v-model="typedName" class="es-typed-input" />
          </p>
          <p class="es-modal-detail">{{ confirm.detail }}</p>
        </div>
        <div class="es-modal-actions">
          <button class="es-confirm-ok" @click="confirmOk">{{ t('wv.es.confirm.ok') }}</button>
          <button class="es-confirm-cancel" @click="confirmCancel">{{ t('wv.es.confirm.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.es-view { display: flex; flex-direction: column; height: 100vh; }
.es-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.es-header { display: flex; gap: 10px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
.es-conn { font-weight: 600; }
.es-color-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.es-endpoint { opacity: .7; }
.es-ro-badge { color: var(--vscode-editorWarning-foreground, #d29922); }
.es-tabs { display: flex; gap: 4px; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.es-tab { background: none; border: none; padding: 4px 10px; cursor: pointer; color: var(--vscode-foreground); border-radius: 3px; }
.es-tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.es-spacer { flex: 1; }
.es-refresh { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; }
.es-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.es-modal { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; width: min(520px, 90vw); }
.es-modal-title { font-weight: 700; margin-bottom: 8px; }
.es-modal-body p { margin: 6px 0; font-size: 13px; }
.es-modal-typed { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.es-typed-input { flex: 1; min-width: 180px; }
.es-modal-detail { font-family: var(--vscode-editor-font-family, monospace); opacity: .8; }
.es-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
</style>