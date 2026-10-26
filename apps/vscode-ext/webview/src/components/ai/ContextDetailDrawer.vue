<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';

export interface ContextDetailState {
  commentCount: number;
  tableCount: number;
  totalTables: number;
  /** 本次实际注入的表清单（SQL 引擎；其余引擎为空）。 */
  tables?: string[];
}

/**
 * 「实际注入的表」清单（嵌入 AI 侧栏；S7g 精简：仅表清单 + 统计）。
 *
 * - 只读反映本次请求真正进入 prompt 的表（受 40K 预算/预筛影响）；
 * - 点击表名 → 打开「表/列说明」编辑器（唯一编辑入口）。
 * 术语表/默认规则改由命令面板配置，不再在此展示原文。
 */
const props = defineProps<{ detail: ContextDetailState | null }>();
const emit = defineEmits<{ editTable: [table: string] }>();
const { t } = useI18n();
</script>

<template>
  <div class="ai-ctx-drawer">
    <div v-if="!props.detail" class="ai-ctx-empty">{{ t('wv.ai.context.loading') }}</div>
    <template v-else>
      <div class="ai-ctx-meta">
        {{ t('wv.ai.context.detailMeta', { tables: props.detail.tableCount, total: props.detail.totalTables, comments: props.detail.commentCount }) }}
      </div>
      <div v-if="props.detail.history" class="ai-ctx-hint">
        {{ t('wv.ai.context.historyMeta', {
          recent: props.detail.history.recent,
          summarized: props.detail.history.summarized,
          chars: props.detail.history.chars,
        }) }}
      </div>
      <div class="ai-ctx-hint">{{ t('wv.ai.context.tablesHint') }}</div>
      <div class="ai-ctx-list">
        <button
          v-for="name in props.detail.tables ?? []"
          :key="name"
          class="ai-ctx-item"
          :title="t('wv.ai.notes.edit')"
          @click="emit('editTable', name)"
        >{{ name }}</button>
        <div v-if="!(props.detail.tables?.length)" class="ai-ctx-empty">{{ t('wv.ai.context.empty') }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-ctx-drawer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}
.ai-ctx-meta {
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  color: var(--vscode-descriptionForeground);
}
.ai-ctx-hint {
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
}
.ai-ctx-list {
  max-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 4px 6px;
}
.ai-ctx-item {
  flex: 0 0 auto;
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: inherit;
  padding: 1px 2px;
  cursor: pointer;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-ctx-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
}
.ai-ctx-empty {
  color: var(--vscode-descriptionForeground);
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
</style>
