<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useVsCode } from '../composables/useVsCode';

interface Field { name: string }
interface Row { [key: string]: any }

const props = defineProps<{
  rows: Row[];
  fields: Field[];
  pkColumns: string[];
  hasTable: boolean;
  sortCol?: string;
  sortDir?: string;
}>();

const emit = defineEmits<{
  sort: [column: string];
  filter: [column: string, value: string];
  updateCell: [pkColumn: string, pkValue: any, column: string, value: string];
  deleteRows: [rows: { pkColumn: string; pkValue: any }[]];
}>();

const { post } = useVsCode();
const filterCol = ref('');
const filterVal = ref('');
const selectedRows = ref<Set<string>>(new Set());
const editingCell = ref<string | null>(null);
const editValue = ref('');

const hasPk = computed(() => props.pkColumns.length > 0);

function getPk(row: Row): { col: string; val: any } | null {
  for (const c of props.pkColumns) {
    if (row[c] !== undefined && row[c] !== null) return { col: c, val: row[c] };
  }
  return null;
}

function startEdit(row: Row, field: Field) {
  if (!props.hasTable) return;
  const pk = getPk(row);
  if (!pk) return;
  const key = `${pk.col}:${pk.val}:${field.name}`;
  editingCell.value = key;
  editValue.value = String(row[field.name] ?? '');
}

function commitEdit(row: Row, field: Field) {
  const pk = getPk(row);
  if (!pk) { editingCell.value = null; return; }
  const oldVal = String(row[field.name] ?? 'NULL');
  if (editValue.value !== oldVal && editValue.value !== 'NULL') {
    post({ type: 'updateCell', pkColumn: pk.col, rowId: pk.val, column: field.name, value: editValue.value });
  }
  editingCell.value = null;
}

function toggleRow(row: Row, checked: boolean) {
  const pk = getPk(row);
  if (!pk) return;
  const key = `${pk.col}:${pk.val}`;
  if (checked) selectedRows.value.add(key);
  else selectedRows.value.delete(key);
}

function deleteSelected() {
  const rows: { pkColumn: string; pkValue: any }[] = [];
  selectedRows.value.forEach(key => {
    const [col, ...valParts] = key.split(':');
    rows.push({ pkColumn: col, pkValue: valParts.join(':') });
  });
  if (!rows.length) return;
  if (confirm(`Delete ${rows.length} row(s)?`)) {
    post({ type: 'deleteRows', rows });
    selectedRows.value.clear();
  }
}

function applyFilter() {
  post({ type: 'filter', column: filterCol.value, value: filterVal.value });
}

function exportData(format: 'json' | 'csv' | 'sql') {
  const tableName = (window as any).__tableName || '';
  const dbName = (window as any).__dbName || '';
  if (!props.rows.length) return;
  let content = '';
  let mime = 'text/plain';
  let filename = 'result.' + format;
  if (format === 'json') {
    content = JSON.stringify(props.rows, null, 2);
    mime = 'application/json';
  } else if (format === 'csv') {
    const headers = props.fields.map(f => f.name);
    const lines = [headers.join(',')];
    props.rows.forEach(row => {
      lines.push(headers.map(h => {
        let v = row[h];
        if (v == null) v = '';
        return '"' + String(v).replace(/"/g, '""') + '"';
      }).join(','));
    });
    content = lines.join('\n');
    mime = 'text/csv';
  } else if (format === 'sql') {
    const bt = '`';
    const headers = props.fields.map(f => f.name);
    props.rows.forEach(row => {
      const values = headers.map(h => {
        let v = row[h];
        if (v == null) return 'NULL';
        if (typeof v === 'number') return String(v);
        return "'" + String(v).replace(/'/g, "''") + "'";
      }).join(', ');
      content += `INSERT INTO ${bt}${dbName}${bt}.${bt}${tableName}${bt} (${headers.map(h => bt + h + bt).join(', ')}) VALUES (${values});\n`;
    });
    mime = 'text/sql';
  }
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

watch(() => props.fields, () => {
  filterCol.value = '';
  filterVal.value = '';
  selectedRows.value.clear();
});
</script>

<template>
  <div class="toolbar">
    <button v-if="hasTable" class="btn danger" :disabled="!selectedRows.size" @click="deleteSelected">
      Delete ({{ selectedRows.size }})
    </button>
    <template v-if="hasTable">
      <span>Filter:</span>
      <select v-model="filterCol" class="input">
        <option value="">--</option>
        <option v-for="f in fields" :key="f.name" :value="f.name">{{ f.name }}</option>
      </select>
      <input v-model="filterVal" class="input" placeholder="value..." @keydown.enter="applyFilter" />
    </template>
    <button class="btn" @click="exportData('csv')">CSV</button>
    <button class="btn" @click="exportData('sql')">SQL</button>
    <button class="btn" @click="exportData('json')">JSON</button>
  </div>
  <div class="grid-wrap">
    <table>
      <thead>
        <tr>
          <th v-if="hasPk" style="width: 30px"></th>
          <th v-for="f in fields" :key="f.name"
            @click="hasTable && $emit('sort', f.name)"
            :class="{ 'sort-asc': sortCol === f.name && sortDir === 'ASC', 'sort-desc': sortCol === f.name && sortDir === 'DESC' }">
            {{ f.name }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, idx) in rows" :key="idx">
          <td v-if="hasPk">
            <input type="checkbox"
              :checked="selectedRows.has((getPk(row)?.col || '') + ':' + (getPk(row)?.val || ''))"
              @change="e => toggleRow(row, (e.target as HTMLInputElement).checked)" />
          </td>
          <td v-for="f in fields" :key="f.name"
            @dblclick="startEdit(row, f)"
            :title="hasTable && getPk(row) ? 'Double-click to edit' : ''">
            <template v-if="editingCell === `${getPk(row)?.col}:${getPk(row)?.val}:${f.name}`">
              <input v-model="editValue" class="cell-edit"
                @blur="commitEdit(row, f)"
                @keydown.enter="commitEdit(row, f)" />
            </template>
            <template v-else>
              {{ row[f.name] === null || row[f.name] === undefined ? 'NULL' : typeof row[f.name] === 'object' ? JSON.stringify(row[f.name]) : row[f.name] }}
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.toolbar { padding: 4px 8px; display: flex; gap: 6px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn.danger { background: var(--vscode-errorForeground); color: #fff; }
.btn:disabled { opacity: 0.5; cursor: default; }
.input { font-size: 12px; padding: 2px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px; }
.grid-wrap { flex: 1; overflow: auto; }
table { border-collapse: collapse; font-size: 13px; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--vscode-editor-background); cursor: pointer; user-select: none; }
th:hover { background: var(--vscode-list-hoverBackground); }
th.sort-asc::after { content: " ▲"; }
th.sort-desc::after { content: " ▼"; }
td { max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
.cell-edit { outline: 2px solid var(--vscode-focusBorder); background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: none; font-size: 13px; padding: 2px 4px; }
</style>
