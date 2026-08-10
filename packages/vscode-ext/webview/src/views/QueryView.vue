<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import ResultGrid from '../components/ResultGrid.vue';

const { post, onMessage } = useVsCode();

const sql = ref('');
const hasTable = ref(false);
const rows = ref<any[]>([]);
const fields = ref<{ name: string }[]>([]);
const results = ref<{ sql: string; rows: any[]; fields: { name: string }[]; costTime: number; truncated?: boolean }[]>([]);
const activeResultIndex = ref(0);
const transactionState = ref<'active' | 'committed' | 'rolledback' | ''>('');
const pkColumns = ref<string[]>([]);
const error = ref('');
const meta = ref('');
const sortCol = ref('');
const sortDir = ref('');
const filterConditions = ref<{ column: string; op: string; value?: string }[]>([]);
const hiddenColumns = ref<string[]>([]);
const columnOrder = ref<string[]>([]);
const columnWidths = ref<Record<string, number>>({});
const offset = ref(0);
const limit = 100;
const total = ref<number | undefined>(undefined);
const tableName = ref('');
const dbName = ref('');
const running = ref(false);

const totalPages = computed(() => total.value === undefined ? 0 : Math.max(1, Math.ceil(total.value / limit)));
const currentPage = computed(() => total.value === undefined ? 0 : Math.floor(offset.value / limit) + 1);

onMounted(() => {
  onMessage((msg: any) => {
    if (msg.type === 'init') {
      sql.value = msg.initialSql || '';
      hasTable.value = msg.hasTable || false;
      tableName.value = msg.tableName || '';
      dbName.value = msg.dbName || '';
      sortCol.value = msg.sortCol || '';
      sortDir.value = msg.sortDir || '';
      filterConditions.value = Array.isArray(msg.filterConditions) ? msg.filterConditions : [];
      hiddenColumns.value = msg.hiddenColumns || [];
      columnOrder.value = msg.columnOrder || [];
      columnWidths.value = msg.columnWidths || {};
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
      error.value = '';
      meta.value = rows.value.length + ' row(s) in ' + (msg.result.costTime / 1000).toFixed(3) + 's' + (msg.result.truncated ? ' (truncated)' : '');
    } else if (msg.type === 'results') {
      const list = msg.results || [];
      const batch = list.map((r: any) => ({
        sql: r.sql || msg.sql || '', rows: r.rows || [], fields: r.fields || [],
        costTime: r.costTime || 0, truncated: r.truncated,
      }));
      results.value = results.value.concat(batch);
      if (results.value.length > 20) results.value = results.value.slice(-20);
      activeResultIndex.value = results.value.length - 1;
      const cur = results.value[activeResultIndex.value];
      if (cur) {
        rows.value = cur.rows;
        fields.value = cur.fields;
        meta.value = cur.rows.length + ' row(s) in ' + (cur.costTime / 1000).toFixed(3) + 's' + (cur.truncated ? ' (truncated)' : '');
      }
      if (msg.sql) sql.value = msg.sql;
      if (msg.transactionState) transactionState.value = msg.transactionState;
      else transactionState.value = '';
      error.value = '';
      pkColumns.value = [];
    } else if (msg.type === 'transaction') {
      transactionState.value = msg.state || '';
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
    } else if (msg.type === 'error') {
      error.value = msg.message;
      rows.value = [];
      fields.value = [];
      total.value = undefined;
      meta.value = '';
    } else if (msg.type === 'cellUpdated') {
      meta.value = 'Cell updated.';
    } else if (msg.type === 'rowsDeleted') {
      meta.value = msg.count + ' row(s) deleted.';
    } else if (msg.type === 'running') {
      running.value = true;
    } else if (msg.type === 'finished') {
      running.value = false;
    }
  });
  post({ type: 'ready' });
});

function run() {
  error.value = '';
  sortCol.value = '';
  sortDir.value = '';
  offset.value = 0;
  post({ type: 'run', sql: sql.value });
}

function selectResult(index: number) {
  activeResultIndex.value = index;
  const r = results.value[index];
  if (r) {
    rows.value = r.rows;
    fields.value = r.fields;
    meta.value = r.rows.length + ' row(s) in ' + (r.costTime / 1000).toFixed(3) + 's';
  }
}

function closeResult(index: number) {
  results.value.splice(index, 1);
  if (activeResultIndex.value >= results.value.length) {
    activeResultIndex.value = Math.max(0, results.value.length - 1);
  }
  const cur = results.value[activeResultIndex.value];
  if (cur) {
    rows.value = cur.rows;
    fields.value = cur.fields;
    meta.value = cur.rows.length + ' row(s) in ' + (cur.costTime / 1000).toFixed(3) + 's';
  }
}

function explain() {
  post({ type: 'explain', sql: sql.value });
}

function cancel() {
  post({ type: 'cancel' });
}

function nextPage() {
  offset.value += limit;
  post({ type: 'nextPage' });
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit);
  post({ type: 'prevPage' });
}

function handleSort(col: string) {
  if (!hasTable.value) return;
  post({ type: 'sort', column: col });
}

function handleFilter(conditions: { column: string; op: string; value?: string }[]) {
  if (!hasTable.value) return;
  filterConditions.value = conditions;
  post({ type: 'filter', conditions });
}

function handleUpdateCell(pkCol: string, pkVal: any, col: string, val: string) {
  post({ type: 'updateCell', pkColumn: pkCol, rowId: pkVal, column: col, value: val });
}

function handleDeleteRows(rows: { pkColumn: string; pkValue: any }[]) {
  post({ type: 'deleteRows', rows });
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

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
  }
}
</script>

<template>
  <div class="app">
    <textarea v-model="sql" class="editor" @keydown="onKeydown" placeholder="Enter SQL..."></textarea>
    <div class="action-bar">
      <button class="btn primary" :disabled="running" @click="run">Run</button>
      <button class="btn" :disabled="running" @click="explain">Explain</button>
      <button v-if="running" class="btn" @click="cancel">Cancel</button>
      <span v-if="transactionState" class="txn-badge" :class="transactionState">TX: {{ transactionState }}</span>
      <div class="spacer"></div>
      <span v-if="hasTable && total !== undefined" class="page-info">
        Page {{ currentPage }} / {{ totalPages }} · {{ total }} row(s)
      </span>
      <button v-if="hasTable" class="btn" :disabled="currentPage <= 1" @click="prevPage">◀ Prev</button>
      <button v-if="hasTable" class="btn" :disabled="currentPage >= totalPages" @click="nextPage">Next ▶</button>
    </div>
    <div v-if="!hasTable && results.length >= 1" class="result-tabs">
      <button v-for="(r, i) in results" :key="i" class="result-tab" :class="{ active: i === activeResultIndex }" @click="selectResult(i)">
        Result {{ i + 1 }} ({{ r.rows.length }})
        <span class="tab-close" @click.stop="closeResult(i)">×</span>
      </button>
    </div>
    <div class="meta" v-if="meta">{{ meta }}</div>
    <div class="error" v-if="error">{{ error }}</div>
    <ResultGrid
      :rows="rows"
      :fields="fields"
      :pk-columns="pkColumns"
      :has-table="hasTable"
      :sort-col="sortCol"
      :sort-dir="sortDir"
      :filter-conditions="filterConditions"
      :column-order="columnOrder"
      :column-widths="columnWidths"
      :table-name="tableName"
      :db-name="dbName"
      :hidden-columns="hiddenColumns"
      @sort="handleSort"
      @filter="handleFilter"
      @update-cell="handleUpdateCell"
      @delete-rows="handleDeleteRows"
      @toggle-column="handleToggleColumn"
      @save-layout="handleSaveLayout"
      @reset-profile="resetProfile"
    />
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; font-family: var(--vscode-font-family); }
.editor { width: 100%; box-sizing: border-box; padding: 8px; min-height: 80px; resize: vertical;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: none; border-bottom: 1px solid var(--vscode-panel-border);
  font-family: var(--vscode-editor-font-family); font-size: 13px; }
.action-bar { padding: 4px 8px; display: flex; gap: 6px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
  .spacer { flex: 1; }
  .page-info { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn.active { border: 1px solid var(--vscode-focusBorder); }
  .txn-badge { font-size: 11px; padding: 2px 6px; border-radius: 3px; }
  .txn-badge.active { background: var(--vscode-inputOption-activeBorder); color: var(--vscode-foreground); }
  .txn-badge.committed { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .txn-badge.rolledback { color: var(--vscode-errorForeground); }
  .result-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); padding: 0 8px; overflow-x: auto; }
  .result-tab { padding: 4px 12px; font-size: 11px; cursor: pointer; border: none; background: none;
    color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; white-space: nowrap; }
  .result-tab.active { color: var(--vscode-textLink-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .tab-close { margin-left: 6px; opacity: 0.6; font-size: 13px; line-height: 1; }
  .tab-close:hover { opacity: 1; color: var(--vscode-errorForeground); }
.meta { padding: 4px 8px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.error { padding: 8px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
</style>
