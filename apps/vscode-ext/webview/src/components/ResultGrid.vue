<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import { FILTER_OP } from '../../../src/utils/filterOps';
import {
  canUseNativePicker, classifyTemporal, formatHintFor, inputTypeFor, isBinaryCell,
  toInputValue, toSqlValue,
  type TemporalKind,
} from '../utils/temporal';
import { buildInsertPayload, buildInsertStatement, clipboardCellText, clipboardRowsText, isNumericText, type CopyFormat } from '../utils/gridOps';
import ConfirmDialog from './ConfirmDialog.vue';

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
  /** PG 命名空间（限定「复制为 INSERT」的目标；dbName 是库名，不能当 schema 用）。 */
  schemaName?: string;
  /** 方言（MYSQL/PG/SQLITE）：决定复制 INSERT 时的标识符引用方式。 */
  dbType?: string;
  hiddenColumns?: string[];
  /**
   * 结果是否可写。视图（VIEW）结果为 false：单元格不可编辑、不提供插入行与
   * 复制 INSERT —— 视图没有可靠的定位列，INSERT 语义也不成立。
   */
  canEdit?: boolean;
  /** 是否提供导出。表结构面板为 false（导出走表节点的 Export）。 */
  allowExport?: boolean;
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
const showCopy = ref(false);
const activeCell = ref<{ row: Row; field: Field } | null>(null);
const activeCellPos = ref<{ rowIdx: number; fieldIdx: number } | null>(null);
const cellMenu = ref<{ x: number; y: number; row: Row; field: Field } | null>(null);
const detailCell = ref<{ column: string; value: unknown } | null>(null);
const search = ref('');
const gridWrap = ref<HTMLElement | null>(null);

const canModifyRows = computed(() => props.hasTable && props.canEdit !== false);
// 行选择用于复制（只读结果也需要）；删除仍只对可编辑表开放。
const canSelectRows = computed(() => props.fields.length > 0);
const localHidden = ref<string[]>([]);
const hiddenSet = computed(() => new Set([...(props.hiddenColumns || []), ...localHidden.value]));
const fieldByName = computed(() => new Map(props.fields.map((field) => [field.name, field])));
const visibleFields = computed(() => displayedOrder.value
  .map((name) => fieldByName.value.get(name))
  .filter((field): field is Field => !!field && !hiddenSet.value.has(field.name)));

const filteredRows = computed(() => {
  if (props.hasTable) return props.rows;
  const q = search.value.trim().toLowerCase();
  if (!q) return props.rows;
  return props.rows.filter((row) => visibleFields.value.some((f) => clipboardCellText(row[f.name]).toLowerCase().includes(q)));
});

const allRowsSelected = computed(() => filteredRows.value.length > 0 && selectedRows.value.length === filteredRows.value.length);

function normalizedOrder(order = props.columnOrder || []): string[] {
  const known = new Set(props.fields.map((field) => field.name));
  const saved = order.filter((name, index) => known.has(name) && order.indexOf(name) === index);
  return [...saved, ...props.fields.map((field) => field.name).filter((name) => !saved.includes(name))];
}

function isHidden(name: string): boolean {
  return hiddenSet.value.has(name);
}

function toggleColumnVisibility(name: string) {
  const hide = !isHidden(name);
  if (props.hasTable) {
    emit('toggleColumn', name, hide);
    return;
  }
  // 任意查询结果没有宿主持久化；列隐藏仅作用于当前结果集。
  localHidden.value = hide
    ? [...localHidden.value, name]
    : localHidden.value.filter((n) => n !== name);
}

function sortColumn(name: string) {
  if (suppressSort.value) {
    suppressSort.value = false;
    return;
  }
  // 任意结果集（非表预览）也允许点列头排序——由上层决定本地排序或服务端重查。
  emit('sort', name);
}

function persistLayout() {
  // 查询结果只做本地布局；只有表预览才把布局写回宿主。
  if (props.hasTable) emit('saveLayout', [...displayedOrder.value], { ...localColumnWidths.value });
}

function resetGridLayout() {
  if (props.hasTable) {
    emit('resetProfile');
    return;
  }
  displayedOrder.value = normalizedOrder([]);
  localColumnWidths.value = {};
  localHidden.value = [];
}

function startColumnDrag(name: string, event: DragEvent) {
  if (!props.fields.length) return;
  draggedColumn.value = name;
  event.dataTransfer?.setData('text/plain', name);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function dropColumn(target: string, event: DragEvent) {
  if (!props.fields.length) return;
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
  if (!props.fields.length) return;
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
  // 无主键时用**全部列**（含隐藏列）作为定位列：只看可见列会让隐藏列不参与
  // WHERE，可能匹配到多行造成静默多行更新/删除。
  const cols = props.pkColumns.length ? props.pkColumns : props.fields.map((f) => f.name);
  if (!cols.length) return null;
  const values = cols.map((c) => row[c]);
  if (values.some((v) => v === undefined)) return null;
  return { columns: cols, values };
}

let editingRow: Row | null = null;
let editingField: Field | null = null;

/**
 * 进入单元格编辑。
 *
 * 编辑态的键用**行下标**而非主键值：无主键表退化为「全部可见列」做定位列，
 * 于是内容相同的两行会算出同一个 key，双击一个格子会让所有同值行一起进入
 * 编辑态（看起来像"改一个全都改了"）。行下标在当前结果集内天然唯一。
 */
function startEdit(row: Row, field: Field, index: number) {
  if (!canModifyRows.value) {
    detailCell.value = { column: field.name, value: row[field.name] };
    return;
  }
  const pk = getPk(row);
  // 无定位列时双击过去毫无反应，用户无从知晓原因
  if (!pk) return showToast(t('wv.grid.cannotEditNoPk'));
  const raw = row[field.name];
  /**
   * 二进制列不能在网格里编辑。
   *
   * `String(raw)` 对 `{type:'Buffer',data:[…]}` 得到 `[object Object]` ——
   * 双击进入编辑再失焦（本组件是"失焦即提交"）就会把这七个字符写进 BLOB 列，
   * 覆盖掉真实字节。图片、加密数据、序列化对象一次误触就没了，
   * 而且看不出发生了什么。
   */
  if (isBinaryCell(raw)) {
    return showToast(t('wv.grid.cannotEditBinary'));
  }
  editingRow = row;
  editingField = field;
  editingCell.value = `${index}:${field.name}`;
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
    emit('updateCell', pk.columns, pk.values, field.name, nextVal);
  }
  cancelEdit();
}

/**
 * 点击编辑框之外。
 *
 * 文本单元格沿用「失焦即提交」；**时间单元格改为放弃**：日期控件要点日历、
 * 翻月份、点年份，任何一次落在编辑框外的点击都会变成一条真实 UPDATE。
 * 时间值改由编辑框内的 ✓ / ✕ 显式确认。
 */
function onDocMouseDown(e: MouseEvent) {
  if (!editingCell.value) return;
  const target = e.target as HTMLElement;
  if (!target) return;
  if (!editContainer.value || editContainer.value.contains(target)) return;
  if (editKind.value) {
    cancelEdit();
    return;
  }
  if (editingRow && editingField) commitEdit(editingRow, editingField);
}

// 刷新/翻页/重跑后 props.rows 整体替换：旧的行对象已不在结果集中，
// 若继续保留 selectedRows，会出现「勾选态全空但 Delete (N) 仍可点」→ 误删上一页的行。
watch(() => props.rows, () => {
  selectedRows.value = [];
  activeCell.value = null;
  activeCellPos.value = null;
});
watch(search, () => { selectedRows.value = []; });

function onDocClickForMenus(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (!target.closest('.cell-menu') && !target.closest('.copy-wrap') && !target.closest('.export-wrap') && !target.closest('.col-menu-wrap')) {
    cellMenu.value = null;
    showCopy.value = false;
    showExport.value = false;
    showColumnMenu.value = false;
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('mousedown', onDocClickForMenus);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('mousedown', onDocClickForMenus);
});

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
  emit('deleteRows', rows);
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
/** 需要数值校验的比较算子；LIKE 家族与空值算子不在此列。 */
const NUMERIC_VALUE_OPS = [
  FILTER_OP.eq, FILTER_OP.ne, FILTER_OP.gt, FILTER_OP.gte, FILTER_OP.lt, FILTER_OP.lte,
  FILTER_OP.between, FILTER_OP.notBetween, FILTER_OP.in, FILTER_OP.notIn,
];
const NUMBER_TYPES = new Set(['int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint', 'decimal', 'numeric', 'float', 'double', 'real']);
const INTEGER_TYPES = new Set(['int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint', 'serial', 'bigserial', 'smallserial', 'year']);

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
function isIntegerColumn(name: string): boolean {
  return INTEGER_TYPES.has(typeStrOf(name));
}
/** 数值输入的键盘形态（桌面端无影响；整数列不该弹小数键盘）。 */
function inputModeFor(name: string): 'numeric' | 'decimal' {
  return isIntegerColumn(name) ? 'numeric' : 'decimal';
}

/**
 * 数值列筛选值是否非法。
 *
 * 输入框已改为文本（数值型输入会被 Vue 转成 Number，丢掉 BIGINT 精度），
 * 浏览器不再拦截非法字符，因此这里自己校验：IN 按逗号列表、BETWEEN 取两段、其余
 * 单值；空值跳过（允许用户只填一半）。返回第一个非法值，合法返回 null。
 */
function invalidNumericFilterValue(cond: Cond): string | null {
  if (!cond.column || !isNumberColumn(cond.column) || !NUMERIC_VALUE_OPS.includes(cond.op)) return null;
  const raw = MULTI_VALUE_OPS.includes(cond.op)
    ? (cond.value ?? '').split(',')
    : DUAL_VALUE_OPS.includes(cond.op)
      ? [cond.value ?? '', cond.value2 ?? '']
      : [cond.value ?? ''];
  return raw.map((v) => v.trim()).find((v) => v !== '' && !isNumericText(v)) ?? null;
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
  const active = conditions.value.filter((c) => c.column);
  for (const cond of active) {
    const bad = invalidNumericFilterValue(cond);
    if (bad !== null) {
      showToast(t('wv.grid.invalidNumber', { column: cond.column, value: bad }));
      return;
    }
  }
  emit('filter', active);
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
type ExportFormat = 'sql' | 'csv' | 'txt' | 'json' | 'xlsx' | 'xml';

/**
 * 可用导出格式。Excel 由扩展端自实现 xlsx 写入（无第三方依赖），
 * 因此始终可用 —— 过去它挂在可选包 xlsx 上，包没装就整项消失。
 */
const EXPORT_FORMATS: { format: ExportFormat; label: string }[] = [
  { format: 'sql', label: 'SQL' },
  { format: 'csv', label: 'CSV' },
  { format: 'txt', label: 'Text' },
  { format: 'json', label: 'JSON' },
  { format: 'xlsx', label: 'Excel' },
  { format: 'xml', label: 'XML' },
];

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
  const fields = visibleFields.value.map((f) => f.name);
  for (const name of fields) {
    const raw = newRow.value[name];
    // 留空走默认值；NULL 字面量是显式空值（与 buildInsertPayload 的约定一致）。
    if (!raw || !isNumberColumn(name) || /^null$/i.test(raw)) continue;
    if (!isNumericText(raw)) {
      showToast(t('wv.grid.invalidNumber', { column: name, value: raw }));
      return;
    }
  }
  const { columns, values } = buildInsertPayload(fields, newRow.value);
  if (columns.length === 0) {
    showToast(t('wv.grid.insertNoValues'));
    return;
  }
  emit('insertRow', columns, values);
  inserting.value = false;
}

function copyAsInsert() {
  if (!props.tableName) return showToast(t('wv.grid.copyNeedsTable'));
  if (!props.rows.length) return showToast(t('wv.grid.nothingToCopy'));
  const targets = selectedRows.value.length ? selectedRows.value : (props.hasTable ? props.rows : filteredRows.value);
  const cols = visibleFields.value.map((f) => f.name);
  const sql = buildInsertStatement(props.tableName, props.dbName, cols, targets, props.dbType, props.schemaName);
  void copyText(sql, t('wv.grid.copiedInserts', { count: targets.length }));
}

async function copyText(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMessage);
  } catch {
    // Webview 剪贴板被策略拦截时，回退到宿主 clipboard。
    post({ type: 'copyText', text });
    showToast(okMessage);
  }
}

function copyCell(value: unknown): void {
  void copyText(clipboardCellText(value), t('wv.grid.copiedCell'));
}

function copyRow(row: Row): void {
  void copyText(clipboardRowsText(visibleFields.value.map((f) => f.name), [row], 'tsv'), t('wv.grid.copiedRows', { count: 1 }));
}

function copyColumnName(field: Field): void {
  void copyText(field.name, t('wv.grid.copiedColumn'));
}

function copyGrid(format: CopyFormat): void {
  showCopy.value = false;
  const targets = selectedRows.value.length ? selectedRows.value : (props.hasTable ? props.rows : filteredRows.value);
  if (!targets.length) return showToast(t('wv.grid.nothingToCopy'));
  void copyText(
    clipboardRowsText(visibleFields.value.map((f) => f.name), targets, format),
    t('wv.grid.copiedRows', { count: targets.length }),
  );
}

function selectCell(row: Row, field: Field, rowIdx: number, fieldIdx: number): void {
  activeCell.value = { row, field };
  activeCellPos.value = { rowIdx, fieldIdx };
  cellMenu.value = null;
  gridWrap.value?.focus();
}

function toggleAll(event: Event): void {
  selectedRows.value = (event.target as HTMLInputElement).checked ? [...filteredRows.value] : [];
}

function openCellMenu(event: MouseEvent, row: Row, field: Field): void {
  event.preventDefault();
  selectCell(row, field);
  cellMenu.value = {
    x: Math.min(event.clientX, Math.max(0, window.innerWidth - 220)),
    y: Math.min(event.clientY, Math.max(0, window.innerHeight - 180)),
    row,
    field,
  };
}

function closeCellMenu(): void {
  cellMenu.value = null;
}

function cellTitle(row: Row, field: Field): string {
  const value = clipboardCellText(row[field.name]);
  const hint = canModifyRows.value && getPk(row) ? t('wv.grid.doubleClickToEdit') : '';
  return hint ? `${value}
${hint}` : value;
}

function isNullCell(value: unknown): boolean {
  return value === null || value === undefined;
}

function viewCellDetail(): void {
  const menu = cellMenu.value;
  if (!menu) return;
  detailCell.value = { column: menu.field.name, value: menu.row[menu.field.name] };
  cellMenu.value = null;
}

/** 详情文本：BLOB 显示前 4KB 十六进制，JSON 缩进，其余使用普通格式化。 */
function formatDetail(value: unknown): string {
  if (value && typeof value === 'object') {
    const v = value as { type?: string; data?: unknown };
    if (v.type === 'Buffer' && Array.isArray(v.data)) {
      const bytes = v.data.slice(0, 4096).map((b) => Number(b).toString(16).padStart(2, '0'));
      const suffix = v.data.length > 4096 ? `\n… (${v.data.length} bytes total)` : '';
      return bytes.join(' ') + suffix;
    }
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  return value === null || value === undefined ? 'NULL' : String(value);
}

function onGridKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
    const selectedText = window.getSelection()?.toString();
    if (selectedText) return;
    event.preventDefault();
    if (activeCell.value) copyCell(activeCell.value.row[activeCell.value.field.name]);
    else copyGrid('tsv');
    return;
  }
  if (event.key === 'Escape') {
    cancelEdit();
    cellMenu.value = null;
    detailCell.value = null;
    return;
  }
  const rows = filteredRows.value;
  const fields = visibleFields.value;
  if (!rows.length || !fields.length) return;
  if (event.key === 'Enter' || event.key === 'F2') {
    if (!activeCellPos.value) return;
    const { rowIdx, fieldIdx } = activeCellPos.value;
    const row = rows[rowIdx];
    const field = fields[fieldIdx];
    if (!row || !field) return;
    event.preventDefault();
    startEdit(row, field, rowIdx);
    return;
  }
  const dir: Record<string, [number, number]> = {
    ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  };
  const delta = dir[event.key];
  if (!delta) return;
  event.preventDefault();
  const cur = activeCellPos.value ?? { rowIdx: 0, fieldIdx: 0 };
  const rowIdx = Math.min(rows.length - 1, Math.max(0, cur.rowIdx + delta[0]));
  const fieldIdx = Math.min(fields.length - 1, Math.max(0, cur.fieldIdx + delta[1]));
  const row = rows[rowIdx]!;
  const field = fields[fieldIdx]!;
  selectCell(row, field, rowIdx, fieldIdx);
  void nextTick(() => {
    gridWrap.value?.querySelector<HTMLElement>(`[data-cell="${rowIdx}:${fieldIdx}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  localHidden.value = [];
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
    <button v-if="canModifyRows && selectedRows.length" class="btn danger" @click="deleteSelected">
      {{ t('wv.grid.deleteSelected', { count: selectedRows.length }) }}
    </button>
    <span v-if="selectedRows.length" class="selected-count">{{ t('wv.grid.selectedRows', { count: selectedRows.length }) }}</span>
    <input v-if="!hasTable && fields.length" v-model="search" class="input search-input" :placeholder="t('wv.grid.searchInResults')" />
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
                v-model="cond.value" class="input" type="text" :inputmode="inputModeFor(cond.column)"
                :placeholder="filterPlaceholderFor(cond)" />
              <input v-else v-model="cond.value" class="input"
                :placeholder="filterPlaceholderFor(cond)" /></template>
            <button class="btn" :aria-label="t('wv.common.delete')" @click="removeCondition(index)">✕</button>
          </div>
          <div class="filter-actions">
            <button class="btn" @click="addCondition">{{ t('wv.grid.addCondition') }}</button>
            <button class="btn primary" @click="applyFilter">{{ t('wv.common.apply') }}</button>
          </div>
        </div>
      </div>
    </template>
    <button v-if="fields.length" class="btn" @click="resetGridLayout">{{ t('wv.grid.resetLayout') }}</button>
    <div v-if="fields.length" class="col-menu-wrap">
      <button class="btn" @click="showColumnMenu = !showColumnMenu">{{ t('wv.grid.columns') }}</button>
      <div v-if="showColumnMenu" class="col-menu">
        <label v-for="f in fields" :key="f.name" class="col-menu-item">
          <input type="checkbox" :checked="!isHidden(f.name)" @change="toggleColumnVisibility(f.name)" />
          {{ f.name }}
        </label>
      </div>
    </div>
    <div v-if="allowExport !== false" class="copy-wrap">
      <button class="btn" :disabled="!rows.length" @click="showCopy = !showCopy">⧉ {{ t('wv.grid.copy') }} ▾</button>
      <div v-if="showCopy" class="copy-menu">
        <button class="menu-item" @click="copyGrid('tsv')">{{ t('wv.grid.formatTsv') }}</button>
        <button class="menu-item" @click="copyGrid('csv')">CSV</button>
        <button class="menu-item" @click="copyGrid('json')">JSON</button>
      </div>
    </div>
    <div v-if="allowExport !== false" class="export-wrap">
      <button class="btn" :disabled="!rows.length" @click="startExport()">{{ t('wv.grid.export') }} ▾</button>
      <div v-if="showExport" class="export-menu">
        <button v-for="f in EXPORT_FORMATS" :key="f.format" class="menu-item"
          @click="startExport(f.format)">{{ f.label }}</button>
      </div>
    </div>
    <button v-if="canModifyRows" class="btn" @click="startInsert">{{ t('wv.grid.insertRow') }}</button>
    <button v-if="canModifyRows" class="btn" :disabled="!rows.length" @click="copyAsInsert">{{ t('wv.grid.copyInsert') }}</button>
  </div>
  <div class="grid-wrap" tabindex="0" @keydown="onGridKeydown">
    <table>
      <thead>
        <tr>
          <th v-if="canSelectRows" style="width: 30px">
            <input type="checkbox" :checked="allRowsSelected" :aria-label="t('wv.grid.selectAll')" @change="toggleAll" />
          </th>
          <th class="row-num">#</th>
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
          <td class="row-num"></td>
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
              type="text" :inputmode="inputModeFor(f.name)" :placeholder="t('wv.common.null')" />
            <input v-else v-model="newRow[f.name]" class="cell-edit"
              :placeholder="insertPlaceholderFor(f.name)" />
          </td>
          <td>
            <button class="btn primary" @click="saveInsert">{{ t('wv.common.save') }}</button>
            <button class="btn" @click="cancelInsert">{{ t('wv.common.cancel') }}</button>
            <small class="insert-hint">{{ t('wv.grid.insertHint') }}</small>
          </td>
        </tr>
        <tr v-if="!inserting && filteredRows.length === 0">
          <td :colspan="visibleFields.length + (canSelectRows ? 1 : 0) + 1" class="empty-row">
            {{ t('wv.grid.noRows') }}
          </td>
        </tr>
        <tr v-for="(row, idx) in filteredRows" :key="idx" :class="{ 'row-selected': isRowSelected(row) }">
          <td v-if="canSelectRows">
            <input type="checkbox"
              :checked="isRowSelected(row)"
              :aria-label="t('wv.grid.selectRow')"
              @change="e => toggleRow(row, (e.target as HTMLInputElement).checked)" />
          </td>
          <td class="row-num">{{ idx + 1 }}</td>
          <td v-for="(f, fieldIdx) in visibleFields" :key="f.name" :style="columnStyle(f.name)"
            :data-cell="`${idx}:${fieldIdx}`"
            :class="{ 'cell-active': activeCellPos?.rowIdx === idx && activeCellPos?.fieldIdx === fieldIdx }"
            @click="selectCell(row, f, idx, fieldIdx)"
            @contextmenu="openCellMenu($event, row, f)"
            @dblclick="startEdit(row, f, idx)"
            :title="cellTitle(row, f)">
            <template v-if="editingCell === `${idx}:${f.name}`">
              <div ref="editContainer" class="cell-edit-wrap">
                <!--
                  时间列走原生 date / time / datetime-local；step=1 是关键，
                  不加的话控件粒度为分钟，TIME 与 DATETIME 的秒会被吃掉。
                  editKind 为 null 时（超范围 TIME、带时区 timestamptz、零日期、
                  非零小数秒，以及所有非时间列）退化为纯文本输入。
                -->
                <template v-if="editKind">
                  <input ref="editInput" v-model="editValue" class="cell-edit"
                    :type="inputTypeFor(editKind)" step="1" :placeholder="formatHintFor(editKind)"
                    @keydown.enter="commitEdit(row, f)"
                    @keydown.esc="cancelEdit" />
                  <!-- 时间值需显式确认：点日历翻月份都会落在编辑框外，不能当作提交 -->
                  <button class="cell-edit-btn ok" :title="t('wv.common.confirm')"
                    @click="commitEdit(row, f)">✓</button>
                  <button class="cell-edit-btn" :title="t('wv.common.cancel')"
                    @click="cancelEdit">✕</button>
                </template>
                <input v-else ref="editInput" v-model="editValue" class="cell-edit"
                  @keydown.enter="commitEdit(row, f)"
                  @keydown.esc="cancelEdit" />
              </div>
            </template>
            <template v-else>
              <span v-if="isNullCell(row[f.name])" class="cell-null">{{ t('wv.common.null') }}</span>
              <span v-else>{{ formatCell(row[f.name]) }}</span>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div v-if="cellMenu" class="cell-menu" :style="{ left: `${cellMenu.x}px`, top: `${cellMenu.y}px` }" @mousedown.stop>
    <button class="menu-item" @click="copyCell(cellMenu.row[cellMenu.field.name]); closeCellMenu()">{{ t('wv.grid.copyValue') }}</button>
    <button class="menu-item" @click="copyRow(cellMenu.row); closeCellMenu()">{{ t('wv.grid.copyRow') }}</button>
    <button class="menu-item" @click="copyColumnName(cellMenu.field); closeCellMenu()">{{ t('wv.grid.copyColumnName') }}</button>
    <button class="menu-item" @click="viewCellDetail">{{ t('wv.grid.viewFull') }}</button>
  </div>

  <div v-if="detailCell" class="cell-detail-mask" @click.self="detailCell = null">
    <div class="cell-detail" role="dialog" aria-modal="true">
      <h3>{{ detailCell.column }}</h3>
      <pre>{{ formatDetail(detailCell.value) }}</pre>
      <div class="cell-detail-actions">
        <button class="btn" @click="copyCell(detailCell.value)">{{ t('wv.grid.copyValue') }}</button>
        <button class="btn primary" @click="detailCell = null">{{ t('wv.common.close') }}</button>
      </div>
    </div>
  </div>

  <ConfirmDialog
    v-if="pendingDelete.length"
    :title="t('wv.grid.deleteRows')"
    :message="t('wv.grid.confirmDeleteRows', { count: pendingDelete.length })"
    :confirm-label="t('wv.common.delete')"
    :cancel-label="t('wv.common.cancel')"
    danger
    @confirm="confirmDelete"
    @cancel="cancelDelete"
  />
  <div v-if="toast" class="toast" role="status" aria-live="polite">{{ toast }}</div>
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
.grid-wrap { flex: 1; overflow: auto; outline: none; }
.search-input { width: 180px; max-width: 40vw; }
.selected-count { font-size: 11px; color: var(--vscode-descriptionForeground, #808080); }
.row-num { width: 48px; min-width: 48px; text-align: right; color: var(--vscode-descriptionForeground, #808080); font-variant-numeric: tabular-nums; }
.cell-null { color: var(--vscode-descriptionForeground, #808080); font-style: italic; opacity: .8; }
table { border-collapse: collapse; font-size: 13px; }
th, td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); padding: 4px 10px; text-align: left; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--vscode-editor-background, #1e1e1e); cursor: pointer; user-select: none; }
th:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
th.sort-asc::after { content: " ▲"; }
th.sort-desc::after { content: " ▼"; }
td { max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
td.cell-active { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: -2px; }
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
.filter-wrap, .export-wrap, .copy-wrap { position: relative; }
.filter-panel { position: absolute; top: 100%; left: 0; z-index: 10; margin-top: 2px; min-width: min(540px, calc(100vw - 24px)); max-width: min(640px, calc(100vw - 24px));
  background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 4px; padding: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
.filter-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
.filter-row .col-select { flex: 0 0 150px; }
.filter-row .op-select { flex: 0 0 100px; }
.filter-row .input { flex: 1; min-width: 0; }
.filter-row .sep { flex: 0 0 auto; color: var(--vscode-descriptionForeground, #808080); font-size: 12px; }
.filter-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.filter-summary { font-size: 11px; color: var(--vscode-descriptionForeground, #808080); cursor: pointer; max-width: 300px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.export-menu, .copy-menu { position: absolute; top: 100%; right: 0; z-index: 10; margin-top: 2px; min-width: 120px;
  background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 3px; padding: 4px; }
.cell-menu { position: fixed; z-index: 120; min-width: 170px; padding: 4px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 4px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
.cell-detail-mask { position: fixed; inset: 0; z-index: 130; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 24px; }
.cell-detail { width: min(720px, 92vw); max-height: 82vh; display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.4); }
.cell-detail h3 { margin: 0; font-size: 14px; }
.cell-detail pre { margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.cell-detail-actions { display: flex; justify-content: flex-end; gap: 6px; }
.menu-item { display: block; width: 100%; text-align: left; padding: 4px 8px; font-size: 12px; cursor: pointer;
  background: transparent; border: none; color: var(--vscode-foreground, #cccccc); }
.menu-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.empty-row { text-align: center; color: var(--vscode-descriptionForeground, #808080); padding: 24px 10px; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 200; padding: 8px 16px; font-size: 12px;
  background: var(--vscode-notifications-background, var(--vscode-editor-background)); color: var(--vscode-foreground, #cccccc);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.cell-edit-wrap { display: inline-flex; align-items: center; gap: 2px; min-width: 140px; }
.cell-edit-btn { flex: 0 0 auto; padding: 2px 6px; font-size: 12px; line-height: 1; cursor: pointer;
  border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff); }
.cell-edit-btn.ok { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
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
.insert-hint { display: block; margin-top: 4px; opacity: .7; font-size: 11px; }
</style>
