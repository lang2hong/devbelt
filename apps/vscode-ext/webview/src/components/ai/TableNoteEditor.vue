<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';

/**
 * 表/列说明编辑器（P9 S7e）。
 *
 * 数据源：host `tableNote`（列元数据 + 现有注记）；保存走 `saveTableNote`（整表覆盖）；
 * 「抓取」按列触发只读样例查询（host 侧限 10 行/敏感列拒绝），结果经 `sampleFill` 回填。
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
const columnNotes = reactive<Record<string, { note: string; sample: string }>>({});
let initializedFor = '';

function initFromProps(): void {
  tableNote.value = props.note ?? '';
  for (const key of Object.keys(columnNotes)) delete columnNotes[key];
  for (const column of props.columns) {
    columnNotes[column.name] = { note: column.note ?? '', sample: column.sample ?? '' };
  }
  initializedFor = props.table;
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
    if (fill && columnNotes[fill.column]) columnNotes[fill.column].sample = fill.text;
  },
);

function save(): void {
  emit('save', {
    table: props.table,
    note: tableNote.value,
    columns: props.columns.map((column) => {
      const entry = columnNotes[column.name] ?? { note: '', sample: '' };
      return { name: column.name, note: entry.note, sample: entry.sample };
    }),
  });
}
</script>

<template>
  <div class="ai-note-editor">
    <div class="ai-nt-head">
      <span class="ai-nt-title">{{ t('wv.ai.notes.title') }} · {{ props.table }}</span>
      <button class="ai-btn" @click="emit('close')">✕</button>
    </div>
    <div v-if="props.loading" class="ai-nt-empty">{{ t('wv.ai.tables.loading') }}</div>
    <template v-else>
      <label class="ai-nt-label">{{ t('wv.ai.notes.tableNote') }}</label>
      <textarea
        v-model="tableNote"
        class="ai-nt-textarea"
        rows="2"
        :placeholder="t('wv.ai.notes.tableNotePlaceholder')"
      ></textarea>
      <div class="ai-nt-hint">{{ t('wv.ai.notes.hint') }}</div>
      <div class="ai-nt-list">
        <div v-if="props.columns.length === 0" class="ai-nt-empty">{{ t('wv.ai.notes.empty') }}</div>
        <div v-for="column in props.columns" :key="column.name" class="ai-nt-row">
          <div class="ai-nt-colmeta">
            <span class="ai-nt-colname">{{ column.name }}</span>
            <span class="ai-nt-coltype">{{ column.type }}</span>
            <span v-if="column.comment" class="ai-nt-colcomment">{{ column.comment }}</span>
          </div>
          <input
            v-model="columnNotes[column.name].note"
            class="ai-nt-input"
            :placeholder="t('wv.ai.notes.colNotePlaceholder')"
          />
          <div class="ai-nt-sample">
            <input
              v-model="columnNotes[column.name].sample"
              class="ai-nt-input"
              :placeholder="t('wv.ai.notes.samplePlaceholder')"
            />
            <button
              class="ai-btn"
              :disabled="props.samplingColumn === column.name"
              @click="emit('fetchSample', column.name)"
            >
              {{ props.samplingColumn === column.name ? t('wv.ai.notes.fetching') : t('wv.ai.notes.fetchSample') }}
            </button>
          </div>
          <div v-if="props.sampleErrors?.[column.name]" class="ai-nt-error">{{ props.sampleErrors[column.name] }}</div>
        </div>
      </div>
      <div class="ai-nt-actions">
        <button class="ai-btn ai-btn-primary" @click="save">{{ t('wv.ai.notes.save') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-note-editor {
  border-right: 1px solid var(--vscode-panel-border);
  width: 340px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 6px 8px;
  gap: 4px;
}
.ai-nt-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--vscode-descriptionForeground);
}
.ai-nt-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-nt-label {
  color: var(--vscode-descriptionForeground);
}
.ai-nt-textarea,
.ai-nt-input {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 2px 6px;
  font-family: inherit;
  font-size: inherit;
  resize: vertical;
}
.ai-nt-hint {
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
}
.ai-nt-list {
  flex: 1;
  overflow: auto;
  min-height: 80px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-nt-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 4px;
}
.ai-nt-colmeta {
  display: flex;
  gap: 6px;
  align-items: baseline;
  overflow: hidden;
}
.ai-nt-colname {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
}
.ai-nt-coltype {
  color: var(--vscode-descriptionForeground);
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
}
.ai-nt-colcomment {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
}
.ai-nt-sample {
  display: flex;
  gap: 4px;
}
.ai-nt-sample .ai-nt-input {
  flex: 1;
}
.ai-nt-error {
  color: var(--vscode-errorForeground, #f48771);
}
.ai-nt-actions {
  display: flex;
  justify-content: flex-end;
}
.ai-nt-empty {
  color: var(--vscode-descriptionForeground);
  padding: 4px 0;
}
</style>