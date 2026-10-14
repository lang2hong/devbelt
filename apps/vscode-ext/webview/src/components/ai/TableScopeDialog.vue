<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';

/**
 * 「注入范围」弹层（方案 A：范围控制收敛为弹层，不再占侧栏视图）。
 *
 * 多选（复选框）+ 搜索；应用于「仅注入所选表」（exclusive），空选择 = 自动模式。
 * 数据源由 host `tableOptions` 下发（≤3000）。编辑表说明请走「注入的表」清单点击。
 */
const props = defineProps<{
  tables: string[];
  selected: string[];
  loading: boolean;
}>();
const emit = defineEmits<{ apply: [tables: string[]]; close: [] }>();

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
  <div class="ai-scope-overlay" @click.self="emit('close')">
    <div class="ai-scope-dialog" role="dialog" :aria-label="t('wv.ai.tables.panelTitle')">
      <div class="ai-scope-head">
        <span>{{ t('wv.ai.tables.panelTitle') }}</span>
        <button class="ai-btn" @click="emit('close')">✕</button>
      </div>
      <div class="ai-scope-hint">{{ t('wv.ai.tables.hint') }}</div>
      <input v-model="search" class="ai-scope-search" :placeholder="t('wv.ai.tables.search')" />
      <div class="ai-scope-actions">
        <button class="ai-btn" @click="selectAllFiltered">{{ t('wv.ai.tables.selectAll') }}</button>
        <button class="ai-btn" @click="clearAll">{{ t('wv.ai.tables.clear') }}</button>
        <span class="ai-scope-count">{{ checked.size }}</span>
      </div>
      <div class="ai-scope-list">
        <div v-if="props.loading" class="ai-scope-empty">{{ t('wv.ai.tables.loading') }}</div>
        <div v-else-if="filtered.length === 0" class="ai-scope-empty">{{ t('wv.ai.tables.empty') }}</div>
        <label v-for="name in filtered" :key="name" class="ai-scope-item">
          <input type="checkbox" :checked="checked.has(name)" @change="toggle(name)" />
          <span class="ai-scope-name">{{ name }}</span>
        </label>
      </div>
      <div class="ai-scope-actions">
        <button class="ai-btn ai-btn-primary" @click="apply">{{ t('wv.ai.tables.apply') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-scope-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.ai-scope-dialog {
  width: min(420px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.ai-scope-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--vscode-foreground);
}
.ai-scope-hint {
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
}
.ai-scope-search {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 4px 8px;
  min-height: 26px;
  font-size: var(--vscode-font-size, 13px);
}
.ai-scope-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ai-scope-count {
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
}
.ai-scope-list {
  flex: 1;
  overflow: auto;
  min-height: 120px;
  max-height: 46vh;
  display: flex;
  flex-direction: column;
}
.ai-scope-item {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 2px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.ai-scope-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
}
.ai-scope-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
}
.ai-scope-empty {
  color: var(--vscode-descriptionForeground);
  padding: 6px 2px;
}
</style>