<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';

/**
 * 表选择（P9 S7d，连接 → 库 → 表 第三级；嵌入 AI 侧栏折叠面板）。
 *
 * 多选（复选框）；搜索在端内过滤。应用于「仅注入所选表」（exclusive），
 * 空选择 = 恢复自动模式。数据源由 host `tableOptions` 下发（≤3000）。
 */
const props = defineProps<{
  tables: string[];
  selected: string[];
  loading: boolean;
}>();
const emit = defineEmits<{ apply: [tables: string[]]; editNote: [table: string] }>();

const { t } = useI18n();
const search = ref('');
const checked = ref<Set<string>>(new Set(props.selected));

watch(
  () => props.selected,
  (value) => {
    checked.value = new Set(value);
  },
);

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  if (!keyword) return props.tables;
  return props.tables.filter((name) => name.toLowerCase().includes(keyword));
});

function toggle(name: string): void {
  const next = new Set(checked.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  checked.value = next;
}

function selectAllFiltered(): void {
  const next = new Set(checked.value);
  for (const name of filtered.value) next.add(name);
  checked.value = next;
}

function clearAll(): void {
  checked.value = new Set();
}

function apply(): void {
  emit('apply', props.tables.filter((name) => checked.value.has(name)));
}
</script>

<template>
  <div class="ai-tp-pane">
    <div class="ai-tp-hint">{{ t('wv.ai.tables.hint') }}</div>
    <input v-model="search" class="ai-tp-search" :placeholder="t('wv.ai.tables.search')" />
    <div class="ai-tp-actions">
      <button class="ai-btn" @click="selectAllFiltered">{{ t('wv.ai.tables.selectAll') }}</button>
      <button class="ai-btn" @click="clearAll">{{ t('wv.ai.tables.clear') }}</button>
      <span class="ai-tp-count">{{ checked.size }}</span>
    </div>
    <div class="ai-tp-list">
      <div v-if="loading" class="ai-tp-empty">{{ t('wv.ai.tables.loading') }}</div>
      <div v-else-if="filtered.length === 0" class="ai-tp-empty">{{ t('wv.ai.tables.empty') }}</div>
      <label v-for="name in filtered" :key="name" class="ai-tp-item">
        <input type="checkbox" :checked="checked.has(name)" @change="toggle(name)" />
        <span class="ai-tp-name">{{ name }}</span>
        <button
          class="ai-btn ai-tp-edit"
          :title="t('wv.ai.notes.edit')"
          @click.prevent.stop="emit('editNote', name)"
        >✎</button>
      </label>
    </div>
    <div class="ai-tp-actions">
      <button class="ai-btn ai-btn-primary" @click="apply">{{ t('wv.ai.tables.apply') }}</button>
    </div>
  </div>
</template>

<style scoped>
.ai-tp-pane {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}
.ai-tp-hint {
  color: var(--vscode-descriptionForeground);
  opacity: 0.8;
}
.ai-tp-search {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 4px 8px;
  min-height: 26px;
  font-size: var(--vscode-font-size, 13px);
}
.ai-tp-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ai-tp-count {
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
}
.ai-tp-list {
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.ai-tp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.ai-tp-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
}
.ai-tp-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-tp-edit {
  margin-left: auto;
  padding: 0 4px;
  line-height: 1;
  opacity: 0.6;
}
.ai-tp-item:hover .ai-tp-edit {
  opacity: 1;
}
.ai-tp-empty {
  color: var(--vscode-descriptionForeground);
  padding: 6px 2px;
}
</style>