<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import ResultGrid from '../components/ResultGrid.vue';
import { deleteRowsMessage, updateCellMessage } from '../utils/gridOps';
import { compareCellValues } from '../utils/gridSort';
import ResultChart from '../components/ResultChart.vue';

const { post, onMessage } = useVsCode();
const { t } = useI18n();

const sql = ref('');
const completionItems = ref<{ label: string; kind: string }[]>([]);
let lastPrefix = '';
const completionIndex = ref(0);
const showCompletion = ref(false);
let completionTimer: any;
const hasTable = ref(false);
/**
 * 面板形态：query = 普通查询/表数据；structure = 表结构清单。
 * 结构面板只是一份列清单，没有 SQL 可跑，也不该提供导出/图表/EXPLAIN。
 */
const viewKind = ref<'query' | 'structure'>('query');
/** 结果对象类型：视图不可编辑（无主键可定位，且 INSERT 语义不成立）。 */
const objectType = ref<'table' | 'view' | ''>('');
const canEdit = ref(false);
const rows = ref<any[]>([]);
const fields = ref<{ name: string }[]>([]);
const results = ref<{
  sql: string; rows: any[]; fields: { name: string }[]; costTime: number;
  truncated?: boolean; affectedRows?: number; kind?: 'dml' | 'ddl' | 'other';
}[]>([]);
const activeResultIndex = ref(0);
const transactionState = ref<'active' | 'committed' | 'rolledback' | ''>('');
const pkColumns = ref<string[]>([]);
const error = ref('');
/** P9 S4：错误诊断附加信息（askAi/secretRisk 由 host 组装；旧消息无这些字段则不显示按钮）。 */
const errorAi = ref<{ sqlForAi: string | null; dbType?: string; secretRisk: boolean; askAi: boolean } | null>(null);
/** 敏感信息确认闸（webview 不支持 window.confirm，用内联确认行）。 */
const aiConfirmPending = ref(false);
/** P9 S4：最近结果是否来自 AI 生成 SQL（0 行诊断按钮显示条件）。 */
const resultAiGenerated = ref(false);
const meta = ref('');
const sortCol = ref('');
const sortDir = ref('');
const filterConditions = ref<{ column: string; op: string; value?: string }[]>([]);
const hiddenColumns = ref<string[]>([]);
const columnOrder = ref<string[]>([]);
const columnWidths = ref<Record<string, number>>({});
const offset = ref(0);
const limit = ref(100);
const total = ref<number | undefined>(undefined);
const tableName = ref('');
const dbName = ref('');
const schemaName = ref('');
const dbType = ref('');
const running = ref(false);
const viewMode = ref<'table' | 'chart'>('table');

/**
 * 任意结果集（非表预览）的本地排序视图：表预览由主进程带 ORDER BY 重查（sortCol/sortDir
 * 来自后端响应），此处仅对已加载行做本地排序。null/undefined 恒排末尾（不随方向翻转）。
 */
const displayRows = computed(() => {
  if (hasTable.value || !sortCol.value || !sortDir.value) return rows.value;
  const col = sortCol.value;
  const dir = sortDir.value === 'DESC' ? -1 : 1;
  return [...rows.value].sort((x, y) => {
    const a = x[col];
    const b = y[col];
    const an = a == null || a === '';
    const bn = b == null || b === '';
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    return compareCellValues(a, b) * dir;
  });
});

const totalPages = computed(() => total.value === undefined ? 0 : Math.max(1, Math.ceil(total.value / limit.value)));
const currentPage = computed(() => total.value === undefined ? 0 : Math.floor(offset.value / limit.value) + 1);
/** 跳页输入框：随当前页变化同步显示。 */
const pageInput = ref(1);
watch(currentPage, (p) => { pageInput.value = p; });

/**
 * EXPLAIN 只对「有执行计划可看」的查询语句有意义（SELECT/WITH/VALUES/TABLE）。
 * DDL/DML/控制语句没有计划可解释：DDL 会语法报错，DML 的 EXPLAIN 要么无意义要么
 * （PG 的 EXPLAIN ANALYZE）有副作用。按钮据此隐藏，避免和 Run 一起无条件出现。
 */
const isExplorable = computed(() => /^\s*(SELECT|WITH|VALUES|TABLE)\b/i.test(sql.value));

/** 结果集？没有字段的结果来自 UPDATE/INSERT/DELETE/DDL，只有受影响行数可报。 */
function isResultSet(r: { fields?: { name: string }[] }): boolean {
  return Array.isArray(r.fields) && r.fields.length > 0;
}

/**
 * 结果摘要文案。写语句必须报「受影响行数」——过去一律按 rows.length 算，
 * 表面板里执行 UPDATE 只会看到 `0 row(s)`，像是没生效。
 */
function describeResult(r: { rows: any[]; fields?: { name: string }[]; costTime: number; truncated?: boolean; affectedRows?: number; kind?: 'dml' | 'ddl' | 'other' }): string {
  const secs = ((r.costTime || 0) / 1000).toFixed(3);
  if (!isResultSet(r)) {
    if (r.kind === 'dml') return `${r.affectedRows ?? 0} ${t('wv.query.rowsAffected')} · ${secs}s`;
    return `${t('wv.query.success')} · ${secs}s`;
  }
  return r.truncated
    ? t('wv.query.resultRowsTruncated', { rows: r.rows.length, seconds: secs })
    : t('wv.query.resultRows', { rows: r.rows.length, seconds: secs });
}

/** 结果标签页文案：写语句显示受影响行数而不是 0。 */
function resultTabLabel(r: { rows: any[]; fields?: { name: string }[]; affectedRows?: number }): string {
  return String(isResultSet(r) ? r.rows.length : (r.affectedRows ?? 0));
}

function filterByPrefix(items: { label: string; kind: string }[], prefix: string) {
  if (!prefix) return items;
  const p = prefix.toLowerCase();
  return items.filter((c) => c.label.toLowerCase().startsWith(p));
}
const filteredCandidates = computed(() => filterByPrefix(completionItems.value, lastPrefix));
watch(filteredCandidates, () => { completionIndex.value = 0; });

let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = onMessage((msg: any) => {
    if (msg.type === 'init') {
      sql.value = msg.initialSql || '';
      hasTable.value = msg.hasTable || false;
      viewKind.value = msg.viewKind === 'structure' ? 'structure' : 'query';
      objectType.value = msg.objectType || '';
      canEdit.value = !!msg.canEdit;
      tableName.value = msg.tableName || '';
      dbName.value = msg.dbName || '';
      schemaName.value = msg.schemaName || '';
      sortCol.value = msg.sortCol || '';
      sortDir.value = msg.sortDir || '';
      filterConditions.value = Array.isArray(msg.filterConditions) ? msg.filterConditions : [];
      hiddenColumns.value = msg.hiddenColumns || [];
      columnOrder.value = msg.columnOrder || [];
      columnWidths.value = msg.columnWidths || {};
      limit.value = msg.limit || 100;
    } else if (msg.type === 'querySql') {
      sql.value = msg.sql || '';
      dbName.value = msg.dbName || '';
      error.value = '';
      offset.value = 0;
    } else if (msg.type === 'result') {
      results.value = [];
      rows.value = msg.result.rows || [];
      fields.value = msg.result.fields || [];
      pkColumns.value = msg.pkColumns || [];
      total.value = msg.total;
      if (msg.sql) sql.value = msg.sql;
      if (msg.hiddenColumns) hiddenColumns.value = msg.hiddenColumns;
      if (msg.columnOrder) columnOrder.value = msg.columnOrder;
      if (msg.columnWidths) columnWidths.value = msg.columnWidths;
      syncLimitFromSql(msg.sql);
      error.value = '';
      if (msg.dbType) dbType.value = msg.dbType;
      resultAiGenerated.value = !!msg.aiGenerated;
      meta.value = describeResult(msg.result);
    } else if (msg.type === 'results') {
      const list = msg.results || [];
      const batch = list.map((r: any) => ({
        sql: r.sql || msg.sql || '', rows: r.rows || [], fields: r.fields || [],
        costTime: r.costTime || 0, truncated: r.truncated, affectedRows: r.affectedRows, kind: r.kind,
      }));
      results.value = results.value.concat(batch);
      if (results.value.length > 20) results.value = results.value.slice(-20);
      if (msg.dbType) dbType.value = msg.dbType;
      activeResultIndex.value = results.value.length - 1;
      const cur = results.value[activeResultIndex.value];
      if (cur) {
        rows.value = cur.rows;
        fields.value = cur.fields;
        meta.value = describeResult(cur);
      }
      if (msg.sql && !msg.explain) sql.value = msg.sql;
      if (msg.transactionState) transactionState.value = msg.transactionState;
      else transactionState.value = '';
      error.value = '';
      pkColumns.value = [];
    } else if (msg.type === 'transaction') {
      transactionState.value = msg.state || '';
    } else if (msg.type === 'hiddenColumns') {
      hiddenColumns.value = msg.hiddenColumns || [];
    } else if (msg.type === 'layout') {
      columnOrder.value = msg.columnOrder || [];
      columnWidths.value = msg.columnWidths || {};
    } else if (msg.type === 'profileReset') {
      sortCol.value = '';
      sortDir.value = '';
      filterConditions.value = [];
      hiddenColumns.value = [];
      columnOrder.value = [];
      columnWidths.value = {};
    } else if (msg.type === 'exported') {
      meta.value = msg.message;
    } else if (msg.type === 'completionItems') {
      completionItems.value = msg.items || [];
      completionIndex.value = 0;
      showCompletion.value = filteredCandidates.value.length > 0;
    } else if (msg.type === 'error') {
      error.value = msg.message;
      errorAi.value = msg.askAi
        ? { sqlForAi: msg.sqlForAi ?? null, dbType: msg.dbType, secretRisk: !!msg.secretRisk, askAi: true }
        : null;
      aiConfirmPending.value = false;
      rows.value = [];
      fields.value = [];
      total.value = undefined;
      meta.value = '';
    } else if (msg.type === 'cellUpdated') {
      meta.value = t('wv.query.cellUpdated');
    } else if (msg.type === 'rowsDeleted') {
      meta.value = t('wv.query.rowsDeleted', { count: msg.count });
    } else if (msg.type === 'running') {
      running.value = true;
    } else if (msg.type === 'finished') {
      running.value = false;
    }
  });
  post({ type: 'ready' });
});
onUnmounted(() => cleanup?.());

function run() {
  error.value = '';
  errorAi.value = null;
  aiConfirmPending.value = false;
  sortCol.value = '';
  sortDir.value = '';
  offset.value = 0;
  post({ type: 'run', sql: sql.value });
}

/** P9 S4：错误诊断（含敏感信息确认闸）。 */
function aiDiagnose() {
  const info = errorAi.value;
  if (!info) return;
  if (info.secretRisk && !aiConfirmPending.value) {
    aiConfirmPending.value = true;
    return;
  }
  post({ type: 'aiDiagnose', sql: info.sqlForAi, message: error.value, dbType: info.dbType });
  aiConfirmPending.value = false;
}

/** P9 S4：0 行结果 → "问 AI 为什么查不到"（带入 SQL + 空结果）。 */
function aiWhyEmpty() {
  post({ type: 'aiWhyEmpty' });
}

function selectResult(index: number) {
  activeResultIndex.value = index;
  error.value = '';
  const r = results.value[index];
  if (r) {
    rows.value = r.rows;
    fields.value = r.fields;
    meta.value = describeResult(r);
  }
}

function closeResult(index: number) {
  error.value = '';
  results.value.splice(index, 1);
  if (activeResultIndex.value >= results.value.length) {
    activeResultIndex.value = Math.max(0, results.value.length - 1);
  }
  const cur = results.value[activeResultIndex.value];
  if (cur) {
    rows.value = cur.rows;
    fields.value = cur.fields;
    meta.value = describeResult(cur);
  } else {
    rows.value = [];
    fields.value = [];
    meta.value = '';
  }
}

function explain() {
  post({ type: 'openExplain', sql: sql.value });
}

function cancel() {
  post({ type: 'cancel' });
}

function nextPage() {
  offset.value += limit.value;
  post({ type: 'nextPage' });
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit.value);
  post({ type: 'prevPage' });
}

/** 随机跳页：offset = (page-1)*limit 后重跑当前查询。 */
function gotoPage() {
  const pages = totalPages.value;
  if (!pages) return;
  const p = Math.min(Math.max(1, Math.floor(Number(pageInput.value) || 1)), pages);
  pageInput.value = p;
  offset.value = (p - 1) * limit.value;
  post({ type: 'gotoPage', page: p });
}

function firstPage() {
  if (currentPage.value <= 1) return;
  offset.value = 0;
  post({ type: 'gotoPage', page: 1 });
}

function lastPage() {
  const pages = totalPages.value;
  if (!pages || currentPage.value >= pages) return;
  offset.value = (pages - 1) * limit.value;
  post({ type: 'gotoPage', page: pages });
}

function setLimit(noRun = false) {
  const n = toLimit(limit.value);
  limit.value = n;
  offset.value = 0;
  sql.value = applyLimitToSql(sql.value, n);
  if (!noRun) post({ type: 'setLimit', limit: n });
  else post({ type: 'setLimit', limit: n, noRun: true });
}

/** 与 db-core QueryService.maxResultRows 对齐：超出会被静默截断，UI 不应允许。 */
const MAX_RESULT_ROWS = 10000;

function toLimit(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(MAX_RESULT_ROWS, Math.floor(n));
}

function applyLimitToSql(sqlText: string, n: number): string {
  if (!sqlText) return sqlText;
  // 只替换 LIMIT 的数字，保留 OFFSET（旧实现会把 `LIMIT n OFFSET m` 整个换掉，丢掉分页偏移）。
  const re = /\bLIMIT\s+\d+/i;
  if (re.test(sqlText)) return sqlText.replace(re, `LIMIT ${n}`);
  return `${sqlText.trim()} LIMIT ${n}`;
}

function syncLimitFromSql(sqlText?: string) {
  // 只对表浏览的 SELECT 同步 limit；任意查询的 SQL 不应被静默改写。
  if (!sqlText || !hasTable.value) return;
  const m = sqlText.match(/\bLIMIT\s+(\d+)/i);
  if (!m) return;
  const n = toLimit(m[1]);
  if (n !== limit.value) {
    limit.value = n;
    setLimit(true);
  }
}

function handleSort(col: string) {
  if (hasTable.value) {
    // 表预览：交给主进程带 ORDER BY 重查。
    post({ type: 'sort', column: col });
    return;
  }
  // 任意结果集：本地排序 + 方向切换。
  if (sortCol.value === col) sortDir.value = sortDir.value === 'ASC' ? 'DESC' : 'ASC';
  else { sortCol.value = col; sortDir.value = 'ASC'; }
}

function handleFilter(conditions: { column: string; op: string; value?: string }[]) {
  if (!hasTable.value) return;
  filterConditions.value = conditions;
  post({ type: 'filter', conditions });
}

function handleUpdateCell(pkColumns: string[], pkValues: any[], col: string, val: string) {
  post(updateCellMessage(pkColumns, pkValues, col, val));
}

function handleDeleteRows(rows: { pkColumns: string[]; pkValues: any[] }[]) {
  post(deleteRowsMessage(rows));
}

function handleInsertRow(columns: string[], values: (string | null)[]) {
  post({ type: 'insertRow', columns, values });
}

function handleToggleColumn(column: string, hidden: boolean) {
  post({ type: 'toggleColumn', column, hidden });
}

function handleSaveLayout(order: string[], widths: Record<string, number>) {
  post({ type: 'saveLayout', columnOrder: order, columnWidths: widths });
}

function resetProfile() {
  post({ type: 'resetProfile' });
}

function positionCompletion() {
  const ta = document.querySelector('.editor') as HTMLTextAreaElement | null;
  const comp = document.querySelector('.completion') as HTMLElement | null;
  if (!ta || !comp) return;
  const caret = ta.selectionStart ?? 0;
  const lines = ta.value.slice(0, caret).split('\n');
  const line = lines.length - 1;
  const col = lines[lines.length - 1].length;
  const style = getComputedStyle(ta);
  const lineHeight = parseFloat(style.lineHeight) || 16;
  const charWidth = (parseFloat(style.fontSize) || 13) * 0.6;
  const r = ta.getBoundingClientRect();
  comp.style.top = (r.top + (line + 1) * lineHeight + 2) + 'px';
  comp.style.left = (r.left + col * charWidth + 6) + 'px';
}

watch(showCompletion, async (v) => {
  if (v) { await nextTick(); positionCompletion(); }
});

function onSqlInput(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  const caret = ta.selectionStart ?? 0;
  const before = ta.value.slice(0, caret);
  lastPrefix = (before.match(/(\w*)$/)?.[1] || '');
  clearTimeout(completionTimer);
  if (!lastPrefix) {
    showCompletion.value = false;
    return;
  }
  completionTimer = setTimeout(() => {
    post({ type: 'completion', before, text: ta.value });
  }, 200);
}

function acceptCompletion() {
  const list = filteredCandidates.value;
  const item = list[completionIndex.value];
  showCompletion.value = false;
  if (!item) return;
  const ta = document.querySelector('.editor') as HTMLTextAreaElement | null;
  if (!ta) return;
  const caret = ta.selectionStart ?? 0;
  const before = sql.value.slice(0, caret);
  const m = before.match(/(\w+)$/);
  const start = m ? caret - m[1].length : caret;
  sql.value = sql.value.slice(0, start) + item.label + sql.value.slice(caret);
  const pos = start + item.label.length;
  setTimeout(() => { ta.focus(); ta.setSelectionRange(pos, pos); }, 0);
}

function selectCompletion(i: number) {
  completionIndex.value = i;
  acceptCompletion();
}

function onKeydown(e: KeyboardEvent) {
  if (showCompletion.value && filteredCandidates.value.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); completionIndex.value = (completionIndex.value + 1) % filteredCandidates.value.length; return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); completionIndex.value = (completionIndex.value - 1 + filteredCandidates.value.length) % filteredCandidates.value.length; return; }
    if (e.key === 'Enter') { e.preventDefault(); acceptCompletion(); return; }
    if (e.key === 'Escape') { e.preventDefault(); showCompletion.value = false; return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
  }
}
</script>

<template>
  <div class="app">
    <!--
      结构面板没有可执行的 SQL：既不提供编辑器与 Run，也不提供 EXPLAIN /
      图表 / 导出（导出走表节点的 Export，语义更清楚）。
    -->
    <textarea v-if="viewKind !== 'structure'" v-model="sql" class="editor" @input="onSqlInput" @keydown="onKeydown" :placeholder="t('wv.query.sqlPlaceholder')"></textarea>
    <div v-if="showCompletion" class="completion">
      <div v-for="(c, i) in filteredCandidates" :key="c.label" :class="['comp-item', 'kind-' + c.kind, { sel: i === completionIndex }]" @mousedown.prevent="selectCompletion(i)">{{ c.label }}</div>
    </div>
    <div class="action-bar">
      <button v-if="viewKind !== 'structure'" class="btn primary" :disabled="running" @click="run">{{ t('wv.query.run') }}</button>
      <button v-if="viewKind !== 'structure' && isExplorable" class="btn" :disabled="running" @click="explain">{{ t('wv.query.explain') }}</button>
      <button v-if="running" class="btn" @click="cancel">{{ t('wv.query.cancel') }}</button>
      <span v-if="transactionState" class="txn-badge" :class="transactionState">{{ t('wv.query.tx') }}: {{ t(`wv.query.tx.${transactionState}`) }}</span>
      <div class="spacer"></div>
      <span v-if="meta" class="page-info">{{ meta }}</span>
    </div>
    <!--
      结果标签页对表面板同样生效：表面板里执行写语句会走多结果分支，
      过去被 `!hasTable` 挡掉，执行结果无处可看。
    -->
    <div v-if="results.length >= 1" class="result-tabs">
      <button v-for="(r, i) in results" :key="i" class="result-tab" :class="{ active: i === activeResultIndex }" @click="selectResult(i)">
        {{ t('wv.query.resultTab', { n: i + 1 }) }} ({{ resultTabLabel(r) }})
        <span class="tab-close" @click.stop="closeResult(i)">×</span>
      </button>
    </div>
    <div class="error" v-if="error">
      {{ error }}
      <div v-if="errorAi" class="ai-error-actions">
        <template v-if="aiConfirmPending">
          <span class="ai-secret-warn">{{ t('wv.ai.diagnose.secretConfirm') }}</span>
          <button class="btn" @click="aiDiagnose">{{ t('wv.ai.diagnose.continue') }}</button>
          <button class="btn" @click="aiConfirmPending = false">{{ t('wv.ai.cancel') }}</button>
        </template>
        <template v-else>
          <button class="btn" @click="aiDiagnose">
            {{ errorAi.secretRisk ? t('wv.ai.diagnose.secretRisk') : t('wv.ai.diagnose.button') }}
          </button>
        </template>
      </div>
    </div>
    <div v-if="resultAiGenerated && !error && rows.length === 0 && fields.length > 0" class="ai-why-empty">
      <button class="btn" @click="aiWhyEmpty">{{ t('wv.ai.whyEmpty.button') }}</button>
    </div>
    <div v-if="rows.length > 0 && viewKind !== 'structure'" class="view-toggle">
      <button class="btn" :class="{ active: viewMode === 'table' }" @click="viewMode = 'table'">{{ t('wv.query.tabTable') }}</button>
      <button class="btn" :class="{ active: viewMode === 'chart' }" @click="viewMode = 'chart'">{{ t('wv.query.tabChart') }}</button>
    </div>
    <template v-if="viewMode === 'table' && fields.length > 0">
      <ResultGrid
      :rows="displayRows"
      :fields="fields"
      :pk-columns="pkColumns"
      :has-table="hasTable"
      :sort-col="sortCol"
      :sort-dir="sortDir"
      :filter-conditions="filterConditions"
      :column-order="columnOrder"
      :column-widths="columnWidths"
      :table-name="tableName"
      :db-type="dbType"
      :db-name="dbName"
      :schema-name="schemaName"
      :hidden-columns="hiddenColumns"
      :can-edit="canEdit"
      :allow-export="viewKind !== 'structure'"
      @sort="handleSort"
      @filter="handleFilter"
      @update-cell="handleUpdateCell"
      @delete-rows="handleDeleteRows"
      @insert-row="handleInsertRow"
      @toggle-column="handleToggleColumn"
      @save-layout="handleSaveLayout"
      @reset-profile="resetProfile"
    />
    </template>
    <ResultChart v-else-if="viewMode === 'chart' && fields.length > 0" :rows="rows" :fields="fields" />
    <!--
      写语句（无结果集）的信息表格：单行单列呈现结果摘要（DML 影响行数 / DDL 成功）。
      过去此处空白，用户看不到执行结果；Navicat 这类工具都会给一条醒目的信息行。
    -->
    <table v-if="results.length > 0 && !error && fields.length === 0" class="result-info">
      <tbody><tr><td>{{ meta }}</td></tr></tbody>
    </table>
    <div v-if="hasTable && total !== undefined" class="result-footer">
      <span class="page-info">{{ t('wv.query.totalRows', { total }) }}</span>
      <span class="spacer"></span>
      <span class="page-info">{{ t('wv.query.pageOf', { page: currentPage, pages: totalPages }) }}</span>
      <label class="page-info">{{ t('wv.query.limit') }}
        <input type="number" v-model.number="limit" class="limit-input" min="1" @change="setLimit()" />
      </label>
      <button class="btn" :disabled="currentPage <= 1" @click="firstPage" :title="t('wv.query.firstPage')">«</button>
      <button class="btn" :disabled="currentPage <= 1" @click="prevPage">{{ t('wv.query.prevPage') }}</button>
      <label class="page-info">{{ t('wv.query.gotoPage') }}
        <input type="number" v-model.number="pageInput" class="limit-input" min="1" :max="totalPages" @change="gotoPage" />
      </label>
      <button class="btn" :disabled="currentPage >= totalPages" @click="nextPage">{{ t('wv.query.nextPage') }}</button>
      <button class="btn" :disabled="currentPage >= totalPages" @click="lastPage" :title="t('wv.query.lastPage')">»</button>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family, sans-serif); }
.editor { width: 100%; box-sizing: border-box; padding: 8px; min-height: 80px; resize: vertical;
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: none; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
  font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; }
.completion { position: fixed; z-index: 50; max-height: 200px; overflow-y: auto;
  background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 3px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); min-width: 160px; }
.comp-item { padding: 3px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
  color: var(--vscode-foreground, #cccccc); }
.comp-item.sel { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #ffffff); }
.comp-item.kind-keyword { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
.comp-item.kind-table { color: var(--vscode-symbolIcon-classForeground, #dcdcaa); }
.comp-item.kind-column { color: var(--vscode-symbolIcon-fieldForeground, #9cdcfe); }
.comp-item.kind-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
.comp-item.kind-operator { color: var(--vscode-symbolIcon-operatorForeground, #d4d4d4); }
.action-bar { padding: 4px 8px; display: flex; gap: 6px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.result-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 5px 8px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
.result-footer .page-info { display: inline-flex; align-items: center; gap: 4px; }
  .spacer { flex: 1; }
  .page-info { font-size: 12px; color: var(--vscode-descriptionForeground, #808080); white-space: nowrap; }
  .limit-input { width: 64px; font-size: 12px; padding: 2px 6px; background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #d4d4d4); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
  .btn.active { border: 1px solid var(--vscode-focusBorder, #007fd4); }
  .txn-badge { font-size: 11px; padding: 2px 6px; border-radius: 3px; }
  .txn-badge.active { background: var(--vscode-inputOption-activeBorder, #007fd4); color: var(--vscode-foreground, #cccccc); }
  .txn-badge.committed { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
  .txn-badge.rolledback { color: var(--vscode-errorForeground, #f48771); }
  .result-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 0 8px; overflow-x: auto; }
  .result-tab { padding: 4px 12px; font-size: 11px; cursor: pointer; border: none; background: none;
    color: var(--vscode-descriptionForeground, #808080); border-bottom: 2px solid transparent; white-space: nowrap; }
  .result-tab.active { color: var(--vscode-textLink-foreground, #4daafc); border-bottom-color: var(--vscode-focusBorder, #007fd4); }
  .tab-close { margin-left: 6px; opacity: 0.6; font-size: 13px; line-height: 1; }
  .tab-close:hover { opacity: 1; color: var(--vscode-errorForeground, #f48771); }
.meta { padding: 4px 8px; font-size: 12px; color: var(--vscode-descriptionForeground, #808080); }
.error { padding: 8px; color: var(--vscode-errorForeground, #f48771); white-space: pre-wrap; }
.result-info { width: 100%; border-collapse: collapse; }
.result-info td { padding: 8px 12px; font-size: 12px; color: var(--vscode-foreground, #cccccc);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); background: var(--vscode-editor-background, #1e1e1e); }
.ai-error-actions { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.ai-secret-warn { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 12px; }
.ai-why-empty { padding: 6px 8px; }
</style>
