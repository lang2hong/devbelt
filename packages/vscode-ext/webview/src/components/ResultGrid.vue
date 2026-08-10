<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useVsCode } from '../composables/useVsCode';

interface Field { name: string; simpleType?: string; type?: string }
interface Row { [key: string]: any }
interface Cond { column: string; op: string; value?: string; value2?: string }

const props = defineProps<{
  rows: Row[];
  fields: Field[];
  pkColumns: string[];
  hasTable: boolean;
  sortCol?: string;
  sortDir?: string;
  filterConditions?: Cond[];
  columnOrder?: string[];
  columnWidths?: Record<string, number>;
  tableName?: string;
  dbName?: string;
  hiddenColumns?: string[];
}>();

const emit = defineEmits<{
  sort: [column: string];
  filter: [conditions: Cond[]];
  updateCell: [pkColumn: string, pkValue: any, column: string, value: string];
  deleteRows: [rows: { pkColumn: string; pkValue: any }[]];
  toggleColumn: [column: string, hidden: boolean];
  saveLayout: [columnOrder: string[], columnWidths: Record<string, number>];
  resetProfile: [];
}>();

const { post } = useVsCode();
const conditions = ref<Cond[]>([]);
const showFilter = ref(false);
const showExport = ref(false);
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

const FILTER_GROUPS = [
  { label: 'Numeric', ops: [
    { value: 'eq', label: '=' },
    { value: 'ne', label: '!=' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '<=' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '>=' },
    { value: 'between', label: 'between' },
    { value: 'notBetween', label: 'not between' },
  ]},
  { label: 'String', ops: [
    { value: 'contains', label: 'contains' },
    { value: 'notContains', label: 'not contains' },
    { value: 'startsWith', label: 'starts with' },
    { value: 'notStartsWith', label: 'not starts with' },
    { value: 'endsWith', label: 'ends with' },
    { value: 'notEndsWith', label: 'not ends with' },
  ]},
  { label: 'Null/Empty', ops: [
    { value: 'isNull', label: 'is null' },
    { value: 'notNull', label: 'is not null' },
    { value: 'isEmpty', label: 'is empty (\'\')' },
    { value: 'notEmpty', label: 'is not empty' },
  ]},
  { label: 'Set', ops: [
    { value: 'in', label: 'in list' },
    { value: 'notIn', label: 'not in list' },
  ]},
];

const NO_VALUE_OPS = ['isNull', 'notNull', 'isEmpty', 'notEmpty'];
const DUAL_VALUE_OPS = ['between', 'notBetween'];
const MULTI_VALUE_OPS = ['in', 'notIn'];
const DATE_TYPES = new Set(['date']);
const DATETIME_TYPES = new Set(['datetime', 'timestamp']);
const TIME_TYPES = new Set(['time']);
const NUMBER_TYPES = new Set(['int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint', 'decimal', 'numeric', 'float', 'double', 'real']);

function fieldOf(name: string): Field | undefined {
  return props.fields.find((f) => f.name === name);
}
function parseEnumValues(type?: string): string[] {
  if (!type) return [];
  const m = type.match(/(?:enum|set)\s*\((.*)\)/i);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
function enumValuesOf(name: string): string[] {
  return parseEnumValues(fieldOf(name)?.type);
}
function isEnumColumn(name: string): boolean {
  const f = fieldOf(name);
  return !!(f && /^(enum|set)/i.test(f.simpleType || '') && enumValuesOf(name).length);
}
function isDateColumn(name: string): boolean {
  return DATE_TYPES.has((fieldOf(name)?.simpleType || '').toLowerCase());
}
function isTimeColumn(name: string): boolean {
  return TIME_TYPES.has((fieldOf(name)?.simpleType || '').toLowerCase());
}
function isDateTimeColumn(name: string): boolean {
  return DATETIME_TYPES.has((fieldOf(name)?.simpleType || '').toLowerCase());
}
function isNumberColumn(name: string): boolean {
  return NUMBER_TYPES.has((fieldOf(name)?.simpleType || '').toLowerCase());
}

function addCondition() {
  conditions.value.push({ column: '', op: 'contains', value: '', value2: '' });
}

function toggleFilterPanel() {
  showFilter.value = !showFilter.value;
  if (showFilter.value && conditions.value.length === 0) {
    conditions.value.push({ column: '', op: 'contains', value: '', value2: '' });
  }
}

function removeCondition(index: number) {
  conditions.value.splice(index, 1);
}

function applyFilter() {
  emit('filter', conditions.value.filter((c) => c.column));
}

const activeFilterSummary = computed(() => {
  const active = conditions.value.filter((c) => c.column);
  if (!active.length) return '';
  return active.map((c) => {
    const val = c.op === 'isNull' || c.op === 'notNull' ? '' : ` ${c.value ?? ''}`;
    return `${c.column} ${c.op}${val}`.trim();
  }).join(' AND ');
});

function exportData(format: 'csv' | 'json' | 'sql') {
  if (!props.rows.length) return;
  post({ type: 'exportData', format, columns: visibleFields.value.map(f => f.name), rows: props.rows });
}

function startExport(format?: 'csv' | 'json' | 'sql') {
  if (!format) {
    showExport.value = !showExport.value;
    return;
  }
  showExport.value = false;
  exportData(format);
}

watch([() => props.fields, () => props.columnOrder], () => {
  displayedOrder.value = normalizedOrder();
  selectedRows.value.clear();
}, { immediate: true });

watch(() => props.columnWidths, (widths) => {
  localColumnWidths.value = { ...(widths || {}) };
}, { immediate: true });

watch(() => props.filterConditions, (conds) => {
  conditions.value = (conds || []).map((c) => ({ ...c }));
}, { immediate: true });
</script>

<template>
  <div class="toolbar">
    <button v-if="canModifyRows" class="btn danger" :disabled="!selectedRows.size" @click="deleteSelected">
      Delete ({{ selectedRows.size }})
    </button>
    <template v-if="hasTable">
      <div class="filter-wrap">
        <button class="btn" @click="toggleFilterPanel">Filter</button>
        <span v-if="activeFilterSummary" class="filter-summary" @click="toggleFilterPanel">{{ activeFilterSummary }}</span>
        <div v-if="showFilter" class="filter-panel">
          <div v-for="(cond, index) in conditions" :key="index" class="filter-row">
            <select v-model="cond.column" class="input col-select">
              <option value="">-- column --</option>
              <option v-for="f in fields" :key="f.name" :value="f.name">{{ f.name }}</option>
            </select>
            <select v-model="cond.op" class="input op-select">
              <optgroup v-for="g in FILTER_GROUPS" :key="g.label" :label="g.label">
                <option v-for="op in g.ops" :key="op.value" :value="op.value">{{ op.label }}</option>
              </optgroup>
            </select>
            <template v-if="!NO_VALUE_OPS.includes(cond.op)">
              <template v-if="DUAL_VALUE_OPS.includes(cond.op)">
                <input v-model="cond.value" class="input" placeholder="from" />
                <span class="sep">~</span>
                <input v-model="cond.value2" class="input" placeholder="to" />
              </template>
              <select v-else-if="isEnumColumn(cond.column)" v-model="cond.value" class="input">
                <option value="">-- value --</option>
                <option v-for="ev in enumValuesOf(cond.column)" :key="ev" :value="ev">{{ ev }}</option>
              </select>
              <input v-else-if="isDateColumn(cond.column)" v-model="cond.value" class="input" type="date" />
              <input v-else-if="isTimeColumn(cond.column)" v-model="cond.value" class="input" type="time" />
              <input v-else-if="isDateTimeColumn(cond.column)" v-model="cond.value" class="input" type="datetime-local" />
              <input v-else-if="isNumberColumn(cond.column)" v-model="cond.value" class="input" type="number" />
              <input v-else v-model="cond.value" class="input" :placeholder="MULTI_VALUE_OPS.includes(cond.op) ? 'v1, v2, v3' : 'value...'" />
            </template>
            <button class="btn" @click="removeCondition(index)">✕</button>
          </div>
          <div class="filter-actions">
            <button class="btn" @click="addCondition">+ Add</button>
            <button class="btn primary" @click="applyFilter">Apply</button>
          </div>
        </div>
      </div>
    </template>
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
    <div class="export-wrap">
      <button class="btn" :disabled="!rows.length" @click="startExport()">Export ▾</button>
      <div v-if="showExport" class="export-menu">
        <button class="menu-item" @click="startExport('csv')">CSV</button>
        <button class="menu-item" @click="startExport('json')">JSON</button>
        <button class="menu-item" @click="startExport('sql')">SQL</button>
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
.filter-wrap, .export-wrap { position: relative; }
.filter-panel { position: absolute; top: 100%; left: 0; z-index: 10; margin-top: 2px; min-width: 540px; max-width: 640px;
  background: var(--vscode-editor-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
.filter-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.filter-row .col-select { flex: 0 0 150px; }
.filter-row .op-select { flex: 0 0 140px; }
.filter-row .input { flex: 1; min-width: 0; }
.filter-row .sep { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 12px; }
.filter-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.filter-summary { font-size: 11px; color: var(--vscode-descriptionForeground); cursor: pointer; max-width: 300px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.export-menu { position: absolute; top: 100%; right: 0; z-index: 10; margin-top: 2px; min-width: 120px;
  background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 4px; }
.menu-item { display: block; width: 100%; text-align: left; padding: 4px 8px; font-size: 12px; cursor: pointer;
  background: transparent; border: none; color: var(--vscode-foreground); }
.menu-item:hover { background: var(--vscode-list-hoverBackground); }
</style>
