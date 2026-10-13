<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';

/**
 * 表/列说明编辑器（宽弹层版，S7h 方案 A 定稿）。
 *
 * 交互要点：
 * - 列搜索（列名/DB 注释）+ 过滤（全部/未填写/已填写，含计数）；DB 注释可点击展开看全文；
 * - 说明/样例两栏紧凑布局，每列可「抓取」样例（host 只读 LIMIT 10，敏感列拒绝）；
 * - **脏数据保护**：关闭时如有未保存改动 → 保存 / 放弃 / 取消；保存按钮仅在脏时可用；
 * - 保存后 host 回显 `updatedAt` → 顶部「已保存」轻提示 + 最后修改时间刷新。
 */
export interface TableNoteColumn {
  name: string;
  type: string;
  comment?: string;
  note?: string;
  sample?: string;
}

const props = defineProps<{
  table: string;
  note?: string;
  /** 最后修改时间（同步实体 updateTime；缺省不显示）。 */
  updatedAt?: number;
  columns: TableNoteColumn[];
  loading: boolean;
  samplingColumn?: string | null;
  sampleErrors?: Record<string, string>;
  sampleFill?: { column: string; text: string; seq: number } | null;
}>();
const emit = defineEmits<{
  close: [];
  save: [payload: { table: string; note: string; columns: Array<{ name: string; note: string; sample: string }> }];
  fetchSample: [column: string];
}>();

const { t } = useI18n();
const tableNote = ref('');
const colNotes = reactive<Record<string, { note: string; sample: string }>>({});
const search = ref('');
const filter = ref<'all' | 'unfilled' | 'filled'>('all');
const expanded = ref<Set<string>>(new Set());
const confirmClose = ref(false);
const savedFlash = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;
let initializedFor = '';
let initial = { note: '', cols: {} as Record<string, { note: string; sample: string }> };

const updatedLabel = computed(() => (props.updatedAt ? new Date(props.updatedAt).toLocaleString() : ''));

function initFromProps(): void {
  tableNote.value = props.note ?? '';
  for (const key of Object.keys(colNotes)) delete colNotes[key];
  for (const column of props.columns) {
    colNotes[column.name] = { note: column.note ?? '', sample: column.sample ?? '' };
  }
  snapshotInitial();
  initializedFor = props.table;
}

function snapshotInitial(): void {
  initial = {
    note: tableNote.value,
    cols: Object.fromEntries(props.columns.map((column) => [column.name, { ...(colNotes[column.name] ?? { note: '', sample: '' }) }])),
  };
}

watch(
  () => [props.table, props.loading] as const,
  () => {
    if (!props.loading && props.table && initializedFor !== props.table) initFromProps();
  },
  { immediate: true },
);

watch(
  () => props.sampleFill,
  (fill) => {
    if (fill && colNotes[fill.column]) colNotes[fill.column].sample = fill.text;
  },
);

// 保存回显（updatedAt 变化）→ 快照对齐 + 「已保存」轻提示。
watch(
  () => props.updatedAt,
  (next, prev) => {
    if (next !== undefined && next !== prev && initializedFor === props.table) {
      snapshotInitial();
      savedFlash.value = true;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => {
        savedFlash.value = false;
      }, 1800);
    }
  },
);

const dirty = computed(() => {
  if (initial.note !== tableNote.value) return true;
  for (const column of props.columns) {
    const current = colNotes[column.name] ?? { note: '', sample: '' };
    const old = initial.cols[column.name] ?? { note: '', sample: '' };
    if (current.note !== old.note || current.sample !== old.sample) return true;
  }
  return false;
});

const stats = computed(() => {
  let filled = 0;
  for (const column of props.columns) {
    const entry = colNotes[column.name];
    if (entry && (entry.note || entry.sample)) filled += 1;
  }
  return { total: props.columns.length, filled, unfilled: props.columns.length - filled };
});

const filtered = computed(() => {
  let list = props.columns;
  if (filter.value === 'unfilled') {
    list = list.filter((column) => !(colNotes[column.name]?.note || colNotes[column.name]?.sample));
  } else if (filter.value === 'filled') {
    list = list.filter((column) => !!(colNotes[column.name]?.note || colNotes[column.name]?.sample));
  }
  const keyword = search.value.trim().toLowerCase();
  if (keyword) {
    list = list.filter(
      (column) => column.name.toLowerCase().includes(keyword) || (column.comment ?? '').toLowerCase().includes(keyword),
    );
  }
  return list;
});

function columnNote(column: TableNoteColumn): { note: string; sample: string } {
  return colNotes[column.name] ?? { note: '', sample: '' };
}

function toggleComment(name: string): void {
  const next = new Set(expanded.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  expanded.value = next;
}

function requestClose(): void {
  if (dirty.value) {
    confirmClose.value = true;
    return;
  }
  emit('close');
}

function save(): void {
  emit('save', {
    table: props.table,
    note: tableNote.value,
    columns: props.columns.map((column) => {
      const entry = columnNote(column);
      return { name: column.name, note: entry.note, sample: entry.sample };
    }),
  });
}

function saveAndClose(): void {
  confirmClose.value = false;
  save();
  emit('close');
}
</script>

<template>
  <div class="ai-note-overlay" @click.self="requestClose">
    <div class="ai-note-dialog" role="dialog" :aria-label="t('wv.ai.notes.title')">
      <div class="ai-note-head">
        <span class="ai-note-title">{{ t('wv.ai.notes.title') }} · {{ props.table }}</span>
        <span v-if="updatedLabel && !savedFlash" class="ai-note-updated">{{ t('wv.ai.notes.updatedAt', { time: updatedLabel }) }}</span>
        <span v-if="savedFlash" class="ai-note-saved">{{ t('wv.ai.notes.saved') }}</span>
        <button class="ai-btn" @click="requestClose">✕</button>
      </div>
      <div v-if="props.loading" class="ai-note-empty">{{ t('wv.ai.tables.loading') }}</div>
      <template v-else>
        <label class="ai-note-label">{{ t('wv.ai.notes.tableNote') }}</label>
        <textarea v-model="tableNote" class="ai-note-textarea" rows="2" :placeholder="t('wv.ai.notes.tableNotePlaceholder')"></textarea>
        <div class="ai-note-hint">{{ t('wv.ai.notes.hint') }}</div>
        <div class="ai-note-toolbar">
          <input v-model="search" class="ai-note-search" :placeholder="t('wv.ai.notes.searchColumns')" />
          <select v-model="filter" class="ai-note-filter">
            <option value="all">{{ t('wv.ai.notes.filterAll') }} ({{ stats.total }})</option>
            <option value="unfilled">{{ t('wv.ai.notes.filterUnfilled') }} ({{ stats.unfilled }})</option>
            <option value="filled">{{ t('wv.ai.notes.filterFilled') }} ({{ stats.filled }})</option>
          </select>
        </div>
        <div class="ai-note-list">
          <div v-if="filtered.length === 0" class="ai-note-empty">{{ t('wv.ai.notes.empty') }}</div>
          <div v-for="column in filtered" :key="column.name" class="ai-note-row">
            <div class="ai-note-meta">
              <span class="ai-note-colname">{{ column.name }}</span>
              <span class="ai-note-coltype">{{ column.type }}</span>
              <span v-if="columnNote(column).note" class="ai-note-badge" :title="t('wv.ai.notes.badgeNote')">✎</span>
              <span v-if="columnNote(column).sample" class="ai-note-badge" :title="t('wv.ai.notes.badgeSample')">#</span>
              <button
                v-if="column.comment"
                class="ai-note-comment"
                :class="{ expanded: expanded.has(column.name) }"
                :title="t('wv.ai.notes.commentTitle')"
                @click="toggleComment(column.name)"
              >{{ column.comment }}</button>
            </div>
            <div class="ai-note-fields">
              <input v-model="colNotes[column.name].note" class="ai-note-input" :placeholder="t('wv.ai.notes.colNotePlaceholder')" />
              <input v-model="colNotes[column.name].sample" class="ai-note-input" :placeholder="t('wv.ai.notes.samplePlaceholder')" />
              <button
                class="ai-btn"
                :disabled="props.samplingColumn === column.name"
                @click="emit('fetchSample', column.name)"
              >{{ props.samplingColumn === column.name ? t('wv.ai.notes.fetching') : t('wv.ai.notes.fetchSample') }}</button>
            </div>
            <div v-if="props.sampleErrors?.[column.name]" class="ai-note-error">{{ props.sampleErrors[column.name] }}</div>
          </div>
        </div>
        <div class="ai-note-footer">
          <button class="ai-btn ai-btn-primary" :disabled="!dirty" @click="save">{{ t('wv.ai.notes.save') }}</button>
        </div>
      </template>
      <div v-if="confirmClose" class="ai-note-confirm">
        <div>{{ t('wv.ai.notes.unsaved') }}</div>
        <div class="ai-note-confirm-actions">
          <button class="ai-btn ai-btn-primary" @click="saveAndClose">{{ t('wv.ai.notes.save') }}</button>
          <button class="ai-btn" @click="emit('close')">{{ t('wv.ai.notes.discard') }}</button>
          <button class="ai-btn" @click="confirmClose = false">{{ t('wv.ai.notes.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-note-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.ai-note-dialog {
  position: relative;
  width: min(640px, 94vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.ai-note-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-foreground);
}
.ai-note-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-note-updated {
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
  white-space: nowrap;
}
.ai-note-saved {
  margin-left: auto;
  color: var(--vscode-testing-iconPassed, #4caf50);
  white-space: nowrap;
}
.ai-note-label {
  color: var(--vscode-descriptionForeground);
}
.ai-note-textarea,
.ai-note-input,
.ai-note-search,
.ai-note-filter {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 3px 6px;
  font-family: inherit;
  font-size: inherit;
  resize: vertical;
}
.ai-note-hint {
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
}
.ai-note-toolbar {
  display: flex;
  gap: 6px;
}
.ai-note-search {
  flex: 1;
  min-height: 24px;
}
.ai-note-list {
  flex: 1;
  overflow: auto;
  min-height: 120px;
  max-height: 52vh;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ai-note-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 3px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.ai-note-meta {
  display: flex;
  gap: 6px;
  align-items: baseline;
  overflow: hidden;
}
.ai-note-colname {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  flex: 0 0 auto;
}
.ai-note-coltype {
  color: var(--vscode-descriptionForeground);
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  flex: 0 0 auto;
}
.ai-note-badge {
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 0 3px;
  font-size: calc(var(--vscode-font-size, 13px) - 3px);
  flex: 0 0 auto;
}
.ai-note-comment {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground);
  font-family: inherit;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
}
.ai-note-comment.expanded {
  white-space: normal;
  text-overflow: unset;
}
.ai-note-fields {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 4px;
}
.ai-note-error {
  color: var(--vscode-errorForeground, #f48771);
}
.ai-note-footer {
  display: flex;
  justify-content: flex-end;
}
.ai-note-empty {
  color: var(--vscode-descriptionForeground);
  padding: 4px 0;
}
.ai-note-confirm {
  position: absolute;
  inset: 0;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  opacity: 0.98;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
}
.ai-note-confirm-actions {
  display: flex;
  gap: 8px;
}
</style>