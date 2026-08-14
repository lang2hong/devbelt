<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import { FILTER_OP } from '../../../src/utils/filterOps';
import {
  canUseNativePicker, classifyTemporal, formatHintFor, inputTypeFor, toInputValue, toSqlValue,
  type TemporalKind,
} from '../utils/temporal';

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
  /** Excel 依赖（可选包 xlsx）是否可用；不可用时隐藏该导出格式 */
  xlsxAvailable?: boolean;
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
const { t } = useI18n();
const conditions = ref<Cond[]>([]);
const showFilter = ref(false);
const showExport = ref(false);
const selectedRows = ref<Row[]>([]);
const editingCell = ref<string | null>(null);
const editValue = ref('');
/** 当前编辑中的单元格是否走原生日期控件（null = 纯文本） */
const editKind = ref<TemporalKind | null>(null);
const editInput = ref<HTMLInputElement | null>(null);
const editContainer = ref<HTMLElement | null>(null);
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
  // 无定位列时双击过去毫无反应，用户无从知晓原因
  if (!pk) return showToast(t('wv.grid.cannotEditNoPk'));
  editingRow = row;
  editingField = field;
  editingCell.value = `${pkKey(row)}:${field.name}`;
  const raw = row[field.name];
  const kind = pickerKindFor(field.name, raw);
  editKind.value = kind;
  // 原生控件要的是 `yyyy-MM-ddTHH:mm:ss` 这类规范格式，DB 文本需先归一
  editValue.value = kind ? (toInputValue(kind, raw) ?? '') : String(raw ?? '');
  setTimeout(() => editInput.value?.focus(), 0);
}

function cancelEdit() {
  editingCell.value = null;
  editKind.value = null;
  editingRow = null;
  editingField = null;
}

function commitEdit(row: Row, field: Field) {
  const pk = getPk(row);
  if (!pk) { cancelEdit(); return; }
  const oldVal = String(row[field.name] ?? 'NULL');
  // 日期控件的 value 是原生格式（带 T），写回前转成 DB 文本再与原值比较，
  // 否则每次打开选择器都会被判定为「改过」而白跑一条 UPDATE
  const nextVal = editKind.value ? toSqlValue(editKind.value, editValue.value) : editValue.value;
  if (nextVal !== oldVal && nextVal !== 'NULL') {
    post({ type: 'updateCell', pkColumns: pk.columns, pkValues: pk.values, column: field.name, value: nextVal });
  }
  cancelEdit();
}

function onDocMouseDown(e: MouseEvent) {
  if (!editingCell.value) return;
  const target = e.target as HTMLElement;
  if (!target) return;
  // 原生选择器的弹层由浏览器渲染在页面之外，不会产生落在文档里的 mousedown，
  // 因此不再需要旧方案针对自绘弹层（.dp__menu）的例外判断
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
  if (!selectedRows.value.length) return showToast(t('wv.grid.selectRowsFirst'));
  const rows: { pkColumns: string[]; pkValues: any[] }[] = [];
  for (const row of selectedRows.value) {
    const pk = getPk(row);
    if (pk) rows.push({ pkColumns: pk.columns, pkValues: pk.values });
  }
  // 选了行却一行都定位不了：不能静默什么都不做
  if (!rows.length) return showToast(t('wv.grid.cannotDeleteNoPk'));
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

/**
 * 筛选操作符下拉项。
 *
 * 必须是 computed：模块级 const 在 import 时就求值，那时 init 消息还没到、
 * setLanguage() 尚未调用，标签会永久锁死英文。
 */
const FILTER_OPS = computed(() => [
  { value: FILTER_OP.eq, label: '=' },
  { value: FILTER_OP.ne, label: '!=' },
  { value: FILTER_OP.contains, label: t('wv.op.contains') },
  { value: FILTER_OP.notContains, label: t('wv.op.notContains') },
  { value: FILTER_OP.startsWith, label: t('wv.op.startsWith') },
  { value: FILTER_OP.endsWith, label: t('wv.op.endsWith') },
  { value: FILTER_OP.notStartsWith, label: t('wv.op.notStartsWith') },
  { value: FILTER_OP.notEndsWith, label: t('wv.op.notEndsWith') },
  { value: FILTER_OP.gt, label: '>' },
  { value: FILTER_OP.gte, label: '>=' },
  { value: FILTER_OP.lt, label: '<' },
  { value: FILTER_OP.lte, label: '<=' },
  { value: FILTER_OP.between, label: t('wv.op.between') },
  { value: FILTER_OP.notBetween, label: t('wv.op.notBetween') },
  { value: FILTER_OP.in, label: t('wv.op.inList') },
  { value: FILTER_OP.notIn, label: t('wv.op.notInList') },
  { value: FILTER_OP.isNull, label: t('wv.op.isNull') },
  { value: FILTER_OP.notNull, label: t('wv.op.isNotNull') },
  { value: FILTER_OP.isEmpty, label: t('wv.op.isEmpty') },
  { value: FILTER_OP.notEmpty, label: t('wv.op.isNotEmpty') },
]);

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
/**
 * 列的时间语义（date / time / datetime / year），非时间列为 null。
 * 判定逻辑集中在 utils/temporal.ts，避免过去「timestamp 被判成仅时间」那类
 * 靠模板 v-if 顺序侥幸兜住的子串匹配。
 */
function temporalKindOf(name: string): TemporalKind | null {
  return classifyTemporal(fieldOf(name)?.simpleType || fieldOf(name)?.type);
}

function isNumberColumn(name: string): boolean {
  return NUMBER_TYPES.has(typeStrOf(name));
}

/**
 * 单元格编辑：该值能否用原生日期控件承载。
 * 承载不了（超范围 TIME、带时区的 timestamptz、零日期、非零小数秒）时退化为
 * 纯文本输入，原样进原样出，不因控件表达力不足而改写数据。
 */
function pickerKindFor(name: string, raw: unknown): TemporalKind | null {
  const kind = temporalKindOf(name);
  if (!kind || kind === 'year') return null;
  return canUseNativePicker(kind, raw) ? kind : null;
}

/** 筛选面板的日期控件：条件值由用户输入，空值也应能直接选。 */
function filterPickerKindFor(name: string, value: string | undefined): TemporalKind | null {
  const kind = temporalKindOf(name);
  if (!kind || kind === 'year') return null;
  return canUseNativePicker(kind, value ?? '') ? kind : null;
}

/**
 * 筛选条件值 → 原生控件 value。
 *
 * 条件值本身始终以 **DB 文本**保存（`2024-01-15 10:30:45`），由 buildCondition
 * 直接拼进 SQL；只在渲染时转成原生格式（`…T…`），避免两种格式在状态里混用。
 */
function temporalInputValue(name: string, value: string | undefined): string {
  const kind = filterPickerKindFor(name, value);
  if (!kind) return value ?? '';
  return toInputValue(kind, value ?? '') ?? '';
}

/** 原生控件 value → 条件值（DB 文本）。 */
function onTemporalFilterInput(cond: Cond, key: 'value' | 'value2', event: Event): void {
  const kind = temporalKindOf(cond.column);
  const raw = (event.target as HTMLInputElement).value;
  cond[key] = kind ? toSqlValue(kind, raw) : raw;
}

/** 文本输入框的占位提示：多值列表 / 时间格式 / 通用。 */
function filterPlaceholderFor(cond: Cond): string {
  if (MULTI_VALUE_OPS.includes(cond.op)) return t('wv.grid.valueList');
  const kind = temporalKindOf(cond.column);
  if (kind) return formatHintFor(kind);
  return t('wv.grid.valuePlaceholder');
}

/**
 * 插入行的时间控件。与单元格编辑同一套规则：
 * newRow 里存 DB 文本，渲染时转原生格式，change 时转回。
 * 过去插入行是清一色的纯文本输入，没有任何类型化控件。
 */
function insertPickerKindFor(name: string): TemporalKind | null {
  return filterPickerKindFor(name, newRow.value[name]);
}

function insertInputValue(name: string): string {
  const kind = insertPickerKindFor(name);
  if (!kind) return newRow.value[name] ?? '';
  return toInputValue(kind, newRow.value[name] ?? '') ?? '';
}

function onTemporalInsertInput(name: string, event: Event): void {
  const kind = temporalKindOf(name);
  const raw = (event.target as HTMLInputElement).value;
  newRow.value[name] = kind ? toSqlValue(kind, raw) : raw;
}

/** 插入行的占位提示：时间列给出期望格式，其余沿用 NULL。 */
function insertPlaceholderFor(name: string): string {
  const kind = temporalKindOf(name);
  return kind ? formatHintFor(kind) : t('wv.common.null');
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

/** 与表导出（commands/database.ts）保持同一格式集合。 */
type ExportFormat = 'sql' | 'csv' | 'json' | 'xlsx' | 'xml';

const ALL_EXPORT_FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'sql', label: 'SQL' },
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
  { format: 'xlsx', label: 'Excel' },
  { format: 'xml', label: 'XML' },
];

/**
 * 可用导出格式。Excel 走可选依赖 xlsx，未安装时必须从菜单里去掉 ——
 * 否则用户点了才在扩展端撞上 'xlsx library not available'。
 */
const EXPORT_FORMATS = computed(() => ALL_EXPORT_FORMATS.filter(
  (f) => f.format !== 'xlsx' || props.xlsxAvailable,
));

function exportData(format: ExportFormat) {
  if (!props.rows.length) return showToast(t('wv.grid.nothingToExport'));
  post({ type: 'exportData', format, columns: visibleFields.value.map(f => f.name), rows: props.rows });
}

function startExport(format?: ExportFormat) {
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
  if (!props.tableName) return showToast(t('wv.grid.copyNeedsTable'));
  if (!props.rows.length) return showToast(t('wv.grid.nothingToCopy'));
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
    showToast(t('wv.grid.copiedInserts', { count: targets.length }));
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
        <button class="btn" @click="toggleFilterPanel">{{ t('wv.grid.filter') }}</button>
        <span v-if="activeFilterSummary" class="filter-summary" @click="toggleFilterPanel">{{ activeFilterSummary }}</span>
        <div v-if="showFilter" class="filter-panel">
          <div v-for="(cond, index) in conditions" :key="index" class="filter-row">
            <select v-model="cond.column" class="input col-select">
              <option value="">{{ t('wv.grid.chooseColumn') }}</option>
              <option v-for="f in fields" :key="f.name" :value="f.name">{{ f.name }}</option>
            </select>
            <select v-model="cond.op" class="input op-select">
              <option v-for="op in FILTER_OPS" :key="op.value" :value="op.value">{{ op.label }}</option>
            </select>
            <template v-if="!NO_VALUE_OPS.includes(cond.op)">
              <template v-if="DUAL_VALUE_OPS.includes(cond.op)">
                <input v-if="filterPickerKindFor(cond.column, cond.value)"
                  class="input"
                  :type="inputTypeFor(filterPickerKindFor(cond.column, cond.value)!)"
                  step="1"
                  :value="temporalInputValue(cond.column, cond.value)"
                  @change="onTemporalFilterInput(cond, 'value', $event)" />
                <input v-else v-model="cond.value" class="input" :placeholder="t('wv.grid.valueFrom')" />
                <span class="sep">~</span>
                <input v-if="filterPickerKindFor(cond.column, cond.value2)"
                  class="input"
                  :type="inputTypeFor(filterPickerKindFor(cond.column, cond.value2)!)"
                  step="1"
                  :value="temporalInputValue(cond.column, cond.value2)"
                  @change="onTemporalFilterInput(cond, 'value2', $event)" />
                <input v-else v-model="cond.value2" class="input" :placeholder="t('wv.grid.valueTo')" />
              </template>
              <select v-else-if="isEnumColumn(cond.column)" v-model="cond.value" class="input">
                <option value="">{{ t('wv.grid.chooseValue') }}</option>
                <option v-for="ev in enumValuesOf(cond.column)" :key="ev" :value="ev">{{ ev }}</option>
              </select>
              <!-- 单值时间条件：原生控件；step=1 让秒位出现（默认粒度是分钟） -->
              <input v-else-if="!MULTI_VALUE_OPS.includes(cond.op) && filterPickerKindFor(cond.column, cond.value)"
                class="input"
                :type="inputTypeFor(filterPickerKindFor(cond.column, cond.value)!)"
                step="1"
                :value="temporalInputValue(cond.column, cond.value)"
                @change="onTemporalFilterInput(cond, 'value', $event)" />
              <input v-else-if="isNumberColumn(cond.column) && !MULTI_VALUE_OPS.includes(cond.op)"
                v-model="cond.value" class="input" type="number" />
              <input v-else v-model="cond.value" class="input"
                :placeholder="filterPlaceholderFor(cond)" /></template>
            <button class="btn" @click="removeCondition(index)">✕</button>
          </div>
          <div class="filter-actions">
            <button class="btn" @click="addCondition">{{ t('wv.grid.addCondition') }}</button>
            <button class="btn primary" @click="applyFilter">{{ t('wv.common.apply') }}</button>
          </div>
        </div>
      </div>
    </template>
    <button v-if="hasTable" class="btn" @click="$emit('resetProfile')">{{ t('wv.grid.resetLayout') }}</button>
    <div v-if="hasTable" class="col-menu-wrap">
      <button class="btn" @click="showColumnMenu = !showColumnMenu">{{ t('wv.grid.columns') }}</button>
      <div v-if="showColumnMenu" class="col-menu">
        <label v-for="f in fields" :key="f.name" class="col-menu-item">
          <input type="checkbox" :checked="!isHidden(f.name)" @change="toggleColumnVisibility(f.name)" />
          {{ f.name }}
        </label>
      </div>
    </div>
    <div class="export-wrap">
      <button class="btn" :disabled="!rows.length" @click="startExport()">{{ t('wv.grid.export') }} ▾</button>
      <div v-if="showExport" class="export-menu">
        <button v-for="f in EXPORT_FORMATS" :key="f.format" class="menu-item"
          @click="startExport(f.format)">{{ f.label }}</button>
      </div>
    </div>
    <button v-if="canModifyRows" class="btn" @click="startInsert">{{ t('wv.grid.insertRow') }}</button>
    <button v-if="hasTable" class="btn" :disabled="!rows.length" @click="copyAsInsert">{{ t('wv.grid.copyInsert') }}</button>
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
            <select v-if="isEnumColumn(f.name)" v-model="newRow[f.name]" class="cell-edit">
              <option value="">{{ t('wv.common.null') }}</option>
              <option v-for="ev in enumValuesOf(f.name)" :key="ev" :value="ev">{{ ev }}</option>
            </select>
            <input v-else-if="insertPickerKindFor(f.name)" class="cell-edit"
              :type="inputTypeFor(insertPickerKindFor(f.name)!)" step="1"
              :value="insertInputValue(f.name)"
              @change="onTemporalInsertInput(f.name, $event)" />
            <input v-else-if="isNumberColumn(f.name)" v-model="newRow[f.name]" class="cell-edit"
              type="number" :placeholder="t('wv.common.null')" />
            <input v-else v-model="newRow[f.name]" class="cell-edit"
              :placeholder="insertPlaceholderFor(f.name)" />
          </td>
          <td>
            <button class="btn primary" @click="saveInsert">{{ t('wv.common.save') }}</button>
            <button class="btn" @click="cancelInsert">{{ t('wv.common.cancel') }}</button>
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
            :title="canModifyRows && getPk(row) ? t('wv.grid.doubleClickToEdit') : ''">
            <template v-if="editingCell === `${pkKey(row)}:${f.name}`">
              <div ref="editContainer" class="cell-edit-wrap">
                <!--
                  时间列走原生 date / time / datetime-local；step=1 是关键，
                  不加的话控件粒度为分钟，TIME 与 DATETIME 的秒会被吃掉。
                  editKind 为 null 时（超范围 TIME、带时区 timestamptz、零日期、
                  非零小数秒，以及所有非时间列）退化为纯文本输入。
                -->
                <input v-if="editKind" ref="editInput" v-model="editValue" class="cell-edit"
                  :type="inputTypeFor(editKind)" step="1" :placeholder="formatHintFor(editKind)"
                  @keydown.enter="commitEdit(row, f)"
                  @keydown.esc="cancelEdit" />
                <input v-else ref="editInput" v-model="editValue" class="cell-edit"
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
      <div class="modal-title">{{ t('wv.grid.deleteRows') }}</div>
      <div class="modal-body">{{ t('wv.grid.confirmDeleteRows', { count: pendingDelete.length }) }}</div>
      <div class="modal-actions">
        <button class="btn" @click="cancelDelete">{{ t('wv.common.cancel') }}</button>
        <button class="btn danger" @click="confirmDelete">{{ t('wv.common.delete') }}</button>
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
/*
 * 原生日期/时间控件的主题适配。
 *
 * 用原生控件替掉自绘弹层后，不再需要几十行 !important 去追第三方组件的内部类名：
 * `color-scheme` 一行就让浏览器把日历弹层、下拉箭头、选中态整体切到深色，
 * 且随 VS Code 主题自动切换。这里只补输入框本身的配色与图标反色。
 */
.vscode-dark, .vscode-high-contrast { color-scheme: dark; }
.vscode-light, .vscode-high-contrast-light { color-scheme: light; }

input[type="date"], input[type="time"], input[type="datetime-local"] {
  font-family: var(--vscode-font-family, sans-serif);
}
/* 深色主题下日历/时钟图标默认是黑色，需反色才看得见 */
.vscode-dark input[type="date"]::-webkit-calendar-picker-indicator,
.vscode-dark input[type="time"]::-webkit-calendar-picker-indicator,
.vscode-dark input[type="datetime-local"]::-webkit-calendar-picker-indicator,
.vscode-high-contrast input[type="date"]::-webkit-calendar-picker-indicator,
.vscode-high-contrast input[type="time"]::-webkit-calendar-picker-indicator,
.vscode-high-contrast input[type="datetime-local"]::-webkit-calendar-picker-indicator {
  filter: invert(1);
  cursor: pointer;
  opacity: 0.75;
}
.vscode-dark input[type="date"]::-webkit-calendar-picker-indicator:hover,
.vscode-dark input[type="time"]::-webkit-calendar-picker-indicator:hover,
.vscode-dark input[type="datetime-local"]::-webkit-calendar-picker-indicator:hover {
  opacity: 1;
}
</style>
