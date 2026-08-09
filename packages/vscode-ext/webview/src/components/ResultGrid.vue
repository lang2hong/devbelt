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
  filterCol?: string;
  filterVal?: string;
  columnOrder?: string[];
  columnWidths?: Record<string, number>;
  tableName?: string;
  dbName?: string;
  hiddenColumns?: string[];
}>();

const emit = defineEmits<{
  sort: [column: string];
  filter: [column: string, value: string];
  updateCell: [pkColumn: string, pkValue: any, column: string, value: string];
  deleteRows: [rows: { pkColumn: string; pkValue: any }[]];
  toggleColumn: [column: string, hidden: boolean];
  saveLayout: [columnOrder: string[], columnWidths: Record<string, number>];
  resetProfile: [];
}>();

const { post } = useVsCode();
const filterCol = ref('');
const filterVal = ref('');
const selectedRows = ref<Set<string>>(new Set());
const editingCell = ref<string | null>(null);
const editValue = ref('');
const showColumnMenu = ref(false);
const displayedOrder = ref<string[]>([]);
const localColumnWidths = ref<Record<string, number>>({});
const draggedColumn = ref('');
const suppressSort = ref(false);

const canModifyRows = computed(() => props.hasTable && props.pkColumns.length === 1);
const hiddenSet = computed(() => new Set(props.hiddenColumns || []));
const fieldByName = computed(() => new Map(props.fields.map((field) => [field.name, field])));
const visibleFields = computed(() => displayedOrder.value
  .map((name) => fieldByName.value.get(name))
  .filter((field): field is Field => !!field && !hiddenSet.value.has(field.name)));

function normalizedOrder(order = props.columnOrder || []): string[] {
  const known = new Set(props.fields.map((field) => field.name));
  const saved = order.filter((name, index) => known.has(name) && order.indexOf(name) === index);
  return [...saved, ...props.fields.map((field) => field.name).filter((name) => !saved.includes(name))];
}

function isHidden(name: string): boolean {
  return hiddenSet.value.has(name);
}

function toggleColumnVisibility(name: string) {
  emit('toggleColumn', name, !isHidden(name));
}

function sortColumn(name: string) {
  if (suppressSort.value) {
    suppressSort.value = false;
    return;
  }
  if (props.hasTable) emit('sort', name);
}

function persistLayout() {
  emit('saveLayout', [...displayedOrder.value], { ...localColumnWidths.value });
}

function startColumnDrag(name: string, event: DragEvent) {
  if (!props.hasTable) return;
  draggedColumn.value = name;
  event.dataTransfer?.setData('text/plain', name);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function dropColumn(target: string, event: DragEvent) {
  if (!props.hasTable) return;
  event.preventDefault();
  const source = draggedColumn.value || event.dataTransfer?.getData('text/plain');
  if (!source || source === target) return;
  const order = [...displayedOrder.value];
  const sourceIndex = order.indexOf(source);
  const targetIndex = order.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return;
  order.splice(sourceIndex, 1);
  order.splice(targetIndex, 0, source);
  displayedOrder.value = order;
  draggedColumn.value = '';
  suppressSort.value = true;
  persistLayout();
}

function columnStyle(name: string): Record<string, string> | undefined {
  const width = localColumnWidths.value[name];
  return width ? { width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` } : undefined;
}

function startColumnResize(name: string, event: PointerEvent) {
  if (!props.hasTable) return;
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startWidth = localColumnWidths.value[name] || (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().width || 120;
  const onMove = (moveEvent: PointerEvent) => {
    localColumnWidths.value = {
      ...localColumnWidths.value,
      [name]: Math.min(1000, Math.max(80, Math.round(startWidth + moveEvent.clientX - startX))),
    };
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    suppressSort.value = true;
    persistLayout();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

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
  const tableName = props.tableName || '';
  const dbName = props.dbName || '';
  if (!props.rows.length) return;
  let content = '';
  let mime = 'text/plain';
  let filename = 'result.' + format;
  if (format === 'json') {
    const headers = visibleFields.value.map(f => f.name);
    const projected = props.rows.map((row) => {
      const out: Row = {};
      headers.forEach((h) => { out[h] = row[h]; });
      return out;
    });
    content = JSON.stringify(projected, null, 2);
    mime = 'application/json';
  } else if (format === 'csv') {
    const headers = visibleFields.value.map(f => f.name);
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
    // SQL 导出由扩展端按当前连接方言生成，确保标识符与限定名正确。
    post({ type: 'exportSql', columns: visibleFields.value.map(f => f.name), rows: props.rows });
    return;
  }
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

watch([() => props.fields, () => props.columnOrder], () => {
  displayedOrder.value = normalizedOrder();
  if (!props.fields.some((field) => field.name === filterCol.value)) {
    filterCol.value = '';
    filterVal.value = '';
  }
  selectedRows.value.clear();
}, { immediate: true });

watch(() => props.columnWidths, (widths) => {
  localColumnWidths.value = { ...(widths || {}) };
}, { immediate: true });

watch(() => [props.filterCol, props.filterVal], ([column, value]) => {
  filterCol.value = column || '';
  filterVal.value = value || '';
}, { immediate: true });
</script>

<template>
  <div class="toolbar">
    <button v-if="canModifyRows" class="btn danger" :disabled="!selectedRows.size" @click="deleteSelected">
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
    <button v-if="hasTable" class="btn" @click="$emit('resetProfile')">Reset Layout</button>
    <div v-if="hasTable" class="col-menu-wrap">
      <button class="btn" @click="showColumnMenu = !showColumnMenu">Columns</button>
      <div v-if="showColumnMenu" class="col-menu">
        <label v-for="f in fields" :key="f.name" class="col-menu-item">
          <input type="checkbox" :checked="!isHidden(f.name)" @change="toggleColumnVisibility(f.name)" />
          {{ f.name }}
        </label>
      </div>
    </div>
  </div>
  <div class="grid-wrap">
    <table>
      <thead>
        <tr>
          <th v-if="canModifyRows" style="width: 30px"></th>
          <th v-for="f in visibleFields" :key="f.name" :style="columnStyle(f.name)"
            :draggable="hasTable"
            @click="sortColumn(f.name)"
            @dragstart="startColumnDrag(f.name, $event)"
            @dragover.prevent
            @drop="dropColumn(f.name, $event)"
            :class="{ 'sort-asc': sortCol === f.name && sortDir === 'ASC', 'sort-desc': sortCol === f.name && sortDir === 'DESC' }">
            {{ f.name }}
            <span v-if="hasTable" class="resize-handle" @pointerdown="startColumnResize(f.name, $event)"></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, idx) in rows" :key="idx">
          <td v-if="canModifyRows">
            <input type="checkbox"
              :checked="selectedRows.has((getPk(row)?.col || '') + ':' + (getPk(row)?.val || ''))"
              @change="e => toggleRow(row, (e.target as HTMLInputElement).checked)" />
          </td>
          <td v-for="f in visibleFields" :key="f.name" :style="columnStyle(f.name)"
            @dblclick="canModifyRows && startEdit(row, f)"
            :title="canModifyRows && getPk(row) ? 'Double-click to edit' : ''">
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
.resize-handle { position: absolute; top: 0; right: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 2; }
.resize-handle:hover { background: var(--vscode-focusBorder); }
.col-menu-wrap { position: relative; }
.col-menu { position: absolute; top: 100%; right: 0; z-index: 10; margin-top: 2px; min-width: 160px; max-height: 240px; overflow: auto;
  background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 4px; }
.col-menu-item { display: flex; align-items: center; gap: 6px; padding: 3px 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }
.col-menu-item:hover { background: var(--vscode-list-hoverBackground); }
</style>
