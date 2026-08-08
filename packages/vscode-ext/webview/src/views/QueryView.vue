<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import ResultGrid from '../components/ResultGrid.vue';

const { post, onMessage } = useVsCode();

const sql = ref('');
const hasTable = ref(false);
const rows = ref<any[]>([]);
const fields = ref<{ name: string }[]>([]);
const pkColumns = ref<string[]>([]);
const error = ref('');
const meta = ref('');
const sortCol = ref('');
const sortDir = ref('');
const offset = ref(0);
const limit = 100;
const tableName = ref('');
const dbName = ref('');

onMounted(() => {
  onMessage((msg: any) => {
    if (msg.type === 'init') {
      sql.value = msg.initialSql || '';
      hasTable.value = msg.hasTable || false;
      tableName.value = msg.tableName || '';
      dbName.value = msg.dbName || '';
    } else if (msg.type === 'result') {
      rows.value = msg.result.rows || [];
      fields.value = msg.result.fields || [];
      pkColumns.value = msg.pkColumns || [];
      error.value = '';
      meta.value = rows.value.length + ' row(s) in ' + (msg.result.costTime / 1000).toFixed(3) + 's';
    } else if (msg.type === 'error') {
      error.value = msg.message;
      rows.value = [];
      fields.value = [];
      meta.value = '';
    } else if (msg.type === 'cellUpdated') {
      meta.value = 'Cell updated.';
    } else if (msg.type === 'rowsDeleted') {
      meta.value = msg.count + ' row(s) deleted.';
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

function handleFilter(col: string, val: string) {
  if (!hasTable.value) return;
  post({ type: 'filter', column: col, value: val });
}

function handleUpdateCell(pkCol: string, pkVal: any, col: string, val: string) {
  post({ type: 'updateCell', pkColumn: pkCol, rowId: pkVal, column: col, value: val });
}

function handleDeleteRows(rows: { pkColumn: string; pkValue: any }[]) {
  post({ type: 'deleteRows', rows });
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
      <button class="btn primary" @click="run">Run</button>
      <button v-if="hasTable" class="btn" @click="prevPage">◀ Prev</button>
      <button v-if="hasTable" class="btn" @click="nextPage">Next ▶</button>
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
      :table-name="tableName"
      :db-name="dbName"
      @sort="handleSort"
      @filter="handleFilter"
      @update-cell="handleUpdateCell"
      @delete-rows="handleDeleteRows"
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
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.meta { padding: 4px 8px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.error { padding: 8px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
</style>
