<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { VueDatePicker } from '@vuepic/vue-datepicker';
import '@vuepic/vue-datepicker/dist/main.css';
import { FILTER_OP } from '../../../src/utils/filterOps';

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
  updateCell: [pkColumns: string[], pkValues: any[], column: string, value: string];
  deleteRows: [rows: { pkColumns: string[]; pkValues: any[] }[]];
  insertRow: [columns: string[], values: (string | null)[]];
  toggleColumn: [column: string, hidden: boolean];
  saveLayout: [columnOrder: string[], columnWidths: Record<string, number>];
  resetProfile: [];
}>();

const { post } = useVsCode();
const conditions = ref<Cond[]>([]);
const showFilter = ref(false);
const showExport = ref(false);
const selectedRows = ref<Row[]>([]);
const editingCell = ref<string | null>(null);
const editValue = ref('');
const editInput = ref<HTMLInputElement | null>(null);
const editContainer = ref<HTMLElement | null>(null);
const editDateRef = ref<any>(null);
const inserting = ref(false);
const newRow = ref<Record<string, string>>({});
const showColumnMenu = ref(false);
const displayedOrder = ref<string[]>([]);
const localColumnWidths = ref<Record<string, number>>({});
const draggedColumn = ref('');
const suppressSort = ref(false);
const pendingDelete = ref<{ pkColumns: string[]; pkValues: any[] }[]>([]);
const toast = ref('');
let toastTimer: any;

const canModifyRows = computed(() => props.hasTable);
const canSelectRows = computed(() => props.hasTable);
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

function getPk(row: Row): { columns: string[]; values: any[] } | null {
  // 无主键时用所有可见列作为定位列（编辑/删除可用，可能影响多行）
  const cols = props.pkColumns.length ? props.pkColumns : visibleFields.value.map((f) => f.name);
  if (!cols.length) return null;
  const values = cols.map((c) => row[c]);
  if (values.some((v) => v === undefined)) return null;
  return { columns: cols, values };
}

function pkKey(row: Row): string {
  const pk = getPk(row);
  if (!pk) return '';
  return pk.values.map((v) => (v === null ? '\0' : String(v))).join('\t');
}

let editingRow: Row | null = null;
let editingField: Field | null = null;

function startEdit(row: Row, field: Field) {
  if (!props.hasTable) return;
  const pk = getPk(row);
  if (!pk) return;
  editingRow = row;
  editingField = field;
  editingCell.value = `${pkKey(row)}:${field.name}`;
  editValue.value = String(row[field.name] ?? '');
  setTimeout(() => {
    const dp = editContainer.value?.querySelector('.dp__input') as HTMLInputElement | undefined;
    if (dp) dp.focus();
    else editInput.value?.focus();
  }, 0);
}

function openDatePicker() {
  (editDateRef.value as any)?.openPicker();
}

function cancelEdit() {
  editingCell.value = null;
  editingRow = null;
  editingField = null;
}

function commitEdit(row: Row, field: Field) {
  const pk = getPk(row);
  if (!pk) { editingCell.value = null; editingRow = null; editingField = null; return; }
  const oldVal = String(row[field.name] ?? 'NULL');
  if (editValue.value !== oldVal && editValue.value !== 'NULL') {
    post({ type: 'updateCell', pkColumns: pk.columns, pkValues: pk.values, column: field.name, value: editValue.value });
  }
  editingCell.value = null;
  editingRow = null;
  editingField = null;
}

function onDocMouseDown(e: MouseEvent) {
  if (!editingCell.value) return;
  const target = e.target as HTMLElement;
  if (!target) return;
  if (target.closest('.dp__menu')) return;
  if (editContainer.value && !editContainer.value.contains(target) && editingRow && editingField) {
    commitEdit(editingRow, editingField);
  }
}

onMounted(() => document.addEventListener('mousedown', onDocMouseDown));
onUnmounted(() => document.removeEventListener('mousedown', onDocMouseDown));

function toggleRow(row: Row, checked: boolean) {
  if (checked) {
    if (!selectedRows.value.includes(row)) selectedRows.value.push(row);
  } else {
    selectedRows.value = selectedRows.value.filter((r) => r !== row);
  }
}

function isRowSelected(row: Row): boolean {
  return selectedRows.value.includes(row);
}

function deleteSelected() {
  const rows: { pkColumns: string[]; pkValues: any[] }[] = [];
  for (const row of selectedRows.value) {
    const pk = getPk(row);
    if (pk) rows.push({ pkColumns: pk.columns, pkValues: pk.values });
  }
  if (!rows.length) return;
  pendingDelete.value = rows;
}

function confirmDelete() {
  const rows = pendingDelete.value;
  if (!rows.length) return;
  pendingDelete.value = [];
  post({ type: 'deleteRows', rows });
  selectedRows.value = [];
}

function cancelDelete() {
  pendingDelete.value = [];
}

const FILTER_OPS = [
  { value: FILTER_OP.eq, label: '=' },
  { value: FILTER_OP.ne, label: '!=' },
  { value: FILTER_OP.contains, label: 'contains' },
  { value: FILTER_OP.notContains, label: 'not contains' },
  { value: FILTER_OP.startsWith, label: 'starts with' },
  { value: FILTER_OP.endsWith, label: 'ends with' },
  { value: FILTER_OP.notStartsWith, label: 'not starts with' },
  { value: FILTER_OP.notEndsWith, label: 'not ends with' },
  { value: FILTER_OP.gt, label: '>' },
  { value: FILTER_OP.gte, label: '>=' },
  { value: FILTER_OP.lt, label: '<' },
  { value: FILTER_OP.lte, label: '<=' },
  { value: FILTER_OP.between, label: 'between' },
  { value: FILTER_OP.notBetween, label: 'not between' },
  { value: FILTER_OP.in, label: 'in list' },
  { value: FILTER_OP.notIn, label: 'not in list' },
  { value: FILTER_OP.isNull, label: 'is null' },
  { value: FILTER_OP.notNull, label: 'is not null' },
  { value: FILTER_OP.isEmpty, label: "is empty ('')" },
  { value: FILTER_OP.notEmpty, label: 'is not empty' },
];

const NO_VALUE_OPS = [FILTER_OP.isNull, FILTER_OP.notNull, FILTER_OP.isEmpty, FILTER_OP.notEmpty];
const DUAL_VALUE_OPS = [FILTER_OP.between, FILTER_OP.notBetween];
const MULTI_VALUE_OPS = [FILTER_OP.in, FILTER_OP.notIn];
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
function typeStrOf(name: string): string {
  const f = fieldOf(name);
  return (f?.simpleType || f?.type || '').toLowerCase();
}
function isEnumColumn(name: string): boolean {
  const f = fieldOf(name);
  return !!(f && /^(enum|set)/i.test(f.simpleType || f.type || '') && enumValuesOf(name).length);
}
function isDateTimeColumn(name: string): boolean {
  const t = typeStrOf(name);
  return t.includes('datetime') || t.includes('timestamp');
}
function isDateColumn(name: string): boolean {
  const t = typeStrOf(name);
  return t === 'date' || (t.includes('date') && !t.includes('time'));
}
function isTimeColumn(name: string): boolean {
  const t = typeStrOf(name);
  return t === 'time' || (t.includes('time') && !t.includes('date'));
}
function isNumberColumn(name: string): boolean {
  return NUMBER_TYPES.has(typeStrOf(name));
}

function addCondition() {
  conditions.value.push({ column: '', op: FILTER_OP.contains, value: '', value2: '' });
}

function toggleFilterPanel() {
  showFilter.value = !showFilter.value;
  if (showFilter.value && conditions.value.length === 0) {
    conditions.value.push({ column: '', op: FILTER_OP.contains, value: '', value2: '' });
  }
}

function removeCondition(index: number) {
  conditions.value.splice(index, 1);
  if (conditions.value.length === 0) showFilter.value = false;
}

function applyFilter() {
  emit('filter', conditions.value.filter((c) => c.column));
  showFilter.value = false;
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

function startInsert() {
  newRow.value = {};
  inserting.value = true;
}

function cancelInsert() {
  inserting.value = false;
}

function saveInsert() {
  const cols = visibleFields.value.map((f) => f.name);
  const values = cols.map((c) => {
    const v = newRow.value[c];
    return v === undefined || v === '' ? null : v;
  });
  emit('insertRow', cols, values);
  inserting.value = false;
}

function copyAsInsert() {
  if (!props.tableName || !props.rows.length) return;
  const targets = selectedRows.value.length ? selectedRows.value : props.rows;
  const cols = visibleFields.value.map((f) => f.name);
  const esc = (v: any): string => (v === null || v === undefined) ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  const q = (name: string) => `\`${name}\``;
  const target = props.dbName ? `${q(props.dbName)}.${q(props.tableName)}` : q(props.tableName);
  const sql = targets.map((row) => {
    const vals = cols.map((c) => esc(row[c])).join(', ');
    return `INSERT INTO ${target} (${cols.map(q).join(', ')}) VALUES (${vals});`;
  }).join('\n');
  void navigator.clipboard.writeText(sql).then(() => {
    showToast(`Copied ${targets.length} INSERT statement(s)`);
  });
}

function showToast(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 2000);
}

function formatCell(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') {
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return `[BLOB ${v.data.length}B]`;
    return JSON.stringify(v);
  }
  return String(v);
}

watch([() => props.fields, () => props.columnOrder], () => {
  displayedOrder.value = normalizedOrder();
  selectedRows.value = [];
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
    <button v-if="canModifyRows" class="btn danger" :disabled="!selectedRows.length" @click="deleteSelected">
      Delete ({{ selectedRows.length }})
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
              <option v-for="op in FILTER_OPS" :key="op.value" :value="op.value">{{ op.label }}</option>
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
              <VueDatePicker
                v-else-if="isDateTimeColumn(cond.column)"
                v-model="cond.value"
                :enable-time-picker="true"
                format="yyyy-MM-dd HH:mm"
                model-type="yyyy-MM-dd HH:mm"
                auto-apply
                teleport-to="body"
                :placeholder="'datetime...'"
                class="dp-input"
              />
              <VueDatePicker
                v-else-if="isDateColumn(cond.column)"
                v-model="cond.value"
                :enable-time-picker="false"
                format="yyyy-MM-dd"
                model-type="yyyy-MM-dd"
                auto-apply
                teleport-to="body"
                :placeholder="'date...'"
                class="dp-input"
              />
              <input v-else-if="isTimeColumn(cond.column)" v-model="cond.value" class="input" type="time" />
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
    <button v-if="canModifyRows" class="btn" @click="startInsert">Insert Row</button>
    <button v-if="hasTable" class="btn" :disabled="!rows.length" @click="copyAsInsert">Copy INSERT</button>
  </div>
  <div class="grid-wrap">
    <table>
      <thead>
        <tr>
          <th v-if="canSelectRows" style="width: 30px"></th>
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
        <tr v-if="inserting" class="insert-row">
          <td v-if="canSelectRows"></td>
          <td v-for="f in visibleFields" :key="f.name" :style="columnStyle(f.name)">
            <input v-model="newRow[f.name]" class="cell-edit" placeholder="NULL" />
          </td>
          <td>
            <button class="btn primary" @click="saveInsert">Save</button>
            <button class="btn" @click="cancelInsert">Cancel</button>
          </td>
        </tr>
        <tr v-for="(row, idx) in rows" :key="idx" :class="{ 'row-selected': isRowSelected(row) }">
          <td v-if="canSelectRows">
            <input type="checkbox"
              :checked="isRowSelected(row)"
              @change="e => toggleRow(row, (e.target as HTMLInputElement).checked)" />
          </td>
          <td v-for="f in visibleFields" :key="f.name" :style="columnStyle(f.name)"
            @dblclick="canModifyRows && startEdit(row, f)"
            :title="canModifyRows && getPk(row) ? 'Double-click to edit' : ''">
            <template v-if="editingCell === `${pkKey(row)}:${f.name}`">
              <div ref="editContainer" class="cell-edit-wrap">
                <input v-if="!isDateTimeColumn(f.name) && !isDateColumn(f.name) && !isTimeColumn(f.name)"
                  ref="editInput" v-model="editValue" class="cell-edit"
                  @keydown.enter="commitEdit(row, f)"
                  @keydown.esc="cancelEdit" />
                <VueDatePicker v-else-if="isDateTimeColumn(f.name)" ref="editDateRef" v-model="editValue"
                  :enable-time-picker="true" time-picker-inline format="yyyy-MM-dd HH:mm:ss" model-type="yyyy-MM-dd HH:mm:ss"
                  auto-apply teleport-to="body" placeholder="yyyy-MM-dd HH:mm:ss" class="dp-input cell-edit"
                  @contextmenu.prevent="openDatePicker"
                  @closed="commitEdit(row, f)" />
                <VueDatePicker v-else-if="isDateColumn(f.name)" ref="editDateRef" v-model="editValue"
                  :enable-time-picker="false" format="yyyy-MM-dd" model-type="yyyy-MM-dd"
                  auto-apply teleport-to="body" placeholder="yyyy-MM-dd" class="dp-input cell-edit"
                  @contextmenu.prevent="openDatePicker"
                  @closed="commitEdit(row, f)" />
                <input v-else ref="editInput" v-model="editValue" class="cell-edit" type="time"
                  @keydown.enter="commitEdit(row, f)"
                  @keydown.esc="cancelEdit" />
              </div>
            </template>
            <template v-else>
              {{ formatCell(row[f.name]) }}
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div v-if="pendingDelete.length" class="modal-mask" @click.self="cancelDelete">
    <div class="modal">
      <div class="modal-title">Delete rows</div>
      <div class="modal-body">Delete {{ pendingDelete.length }} selected row(s)? This cannot be undone.</div>
      <div class="modal-actions">
        <button class="btn" @click="cancelDelete">Cancel</button>
        <button class="btn danger" @click="confirmDelete">Delete</button>
      </div>
    </div>
  </div>
  <div v-if="toast" class="toast">{{ toast }}</div>
</template>

<style scoped>
.toolbar { padding: 4px 8px; display: flex; gap: 6px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); flex-wrap: wrap; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px;
  background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ffffff); }
.btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
.btn.danger { background: var(--vscode-errorForeground, #f48771); color: #fff; }
.btn:disabled { opacity: 0.5; cursor: default; }
.input { font-size: 12px; padding: 2px 6px; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; }
.grid-wrap { flex: 1; overflow: auto; }
table { border-collapse: collapse; font-size: 13px; }
th, td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 4px 10px; text-align: left; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--vscode-editor-background, #1e1e1e); cursor: pointer; user-select: none; }
th:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
th.sort-asc::after { content: " ▲"; }
th.sort-desc::after { content: " ▼"; }
td { max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
.row-selected, .row-selected td { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
.cell-edit { outline: 2px solid var(--vscode-focusBorder, #007fd4); background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: none; font-size: 13px; padding: 2px 4px; }
.resize-handle { position: absolute; top: 0; right: -3px; bottom: 0; width: 6px; cursor: col-resize; z-index: 2; }
.resize-handle:hover { background: var(--vscode-focusBorder, #007fd4); }
.col-menu-wrap { position: relative; }
.col-menu { position: absolute; top: 100%; right: 0; z-index: 10; margin-top: 2px; min-width: 160px; max-height: 240px; overflow: auto;
  background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 3px; padding: 4px; }
.col-menu-item { display: flex; align-items: center; gap: 6px; padding: 3px 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }
.col-menu-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.filter-wrap, .export-wrap { position: relative; }
.filter-panel { position: absolute; top: 100%; left: 0; z-index: 10; margin-top: 2px; min-width: 540px; max-width: 640px;
  background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px; padding: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
.filter-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.filter-row .col-select { flex: 0 0 150px; }
.filter-row .op-select { flex: 0 0 100px; }
.filter-row .input { flex: 1; min-width: 0; }
.filter-row .sep { flex: 0 0 auto; color: var(--vscode-descriptionForeground, #808080); font-size: 12px; }
.filter-row .dp-input { flex: 1; min-width: 0; }
.filter-row .dp-input :deep(input) { width: 100%; font-size: 12px; padding: 4px 8px;
  background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #d4d4d4);
  border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px; box-sizing: border-box; }
.filter-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.filter-summary { font-size: 11px; color: var(--vscode-descriptionForeground, #808080); cursor: pointer; max-width: 300px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.export-menu { position: absolute; top: 100%; right: 0; z-index: 10; margin-top: 2px; min-width: 120px;
  background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 3px; padding: 4px; }
.menu-item { display: block; width: 100%; text-align: left; padding: 4px 8px; font-size: 12px; cursor: pointer;
  background: transparent; border: none; color: var(--vscode-foreground, #cccccc); }
.menu-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 4px; padding: 16px; min-width: 320px; }
.modal-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.modal-body { font-size: 12px; color: var(--vscode-foreground, #cccccc); margin-bottom: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 200; padding: 8px 16px; font-size: 12px;
  background: var(--vscode-notifications-background, var(--vscode-editor-background)); color: var(--vscode-foreground, #cccccc);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.cell-edit-wrap { display: inline-flex; min-width: 140px; }
</style>

<style>
/* VueDatePicker 主题对齐 VS Code 深色界面（菜单 teleport 到 body，需全局覆盖） */
.dp__menu {
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background)) !important;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)) !important;
  border-radius: 4px !important;
  color: var(--vscode-foreground, #cccccc) !important;
  box-shadow: 0 4px 12px rgba(0,0,0,0.35) !important;
}
.dp__calendar,
.dp__calendar_header,
.dp__calendar_header_separator,
.dp__month_year_select,
.dp__month_year_wrap,
.dp__overlay,
.dp__time_col,
.dp__time_row,
.dp__time_controls {
  background: transparent !important;
  color: var(--vscode-foreground, #cccccc) !important;
}
.dp__month_year_select,
.dp__button,
.dp__action_button,
.dp__arrow_button {
  color: var(--vscode-foreground, #cccccc) !important;
}
.dp__month_year_select:hover,
.dp__button:hover,
.dp__arrow_button:hover,
.dp__overlay_cell:hover,
.dp__month_year_select:hover .dp__overlay_cell {
  background: var(--vscode-list-hoverBackground, #2a2d2e) !important;
}
.dp__cell_inner {
  color: var(--vscode-foreground, #cccccc) !important;
  border-radius: 3px !important;
}
.dp__cell_inner:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e) !important;
}
.dp__today {
  border-color: var(--vscode-focusBorder, #007fd4) !important;
  color: var(--vscode-textLink-foreground, var(--vscode-focusBorder)) !important;
}
.dp__active_date,
.dp__range_end,
.dp__range_start,
.dp__range_between {
  background: var(--vscode-button-background, #0e639c) !important;
  color: var(--vscode-button-foreground, #ffffff) !important;
}
.dp__now_invalid,
.dp__cell_disabled,
.dp__cell_outside {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)) !important;
}
.dp__svg {
  fill: var(--vscode-foreground, #cccccc) !important;
}
.dp__input {
  background: var(--vscode-input-background, #3c3c3c) !important;
  color: var(--vscode-input-foreground, #d4d4d4) !important;
  border: 1px solid var(--vscode-input-border, #3c3c3c) !important;
  border-radius: 3px !important;
  font-size: 13px !important;
  padding: 2px 6px !important;
}
.dp__input_focus,
.dp__input:hover {
  border-color: var(--vscode-focusBorder, #007fd4) !important;
}
.dp__overlay_cell_active {
  background: var(--vscode-button-background, #0e639c) !important;
  color: var(--vscode-button-foreground, #ffffff) !important;
}
</style>
