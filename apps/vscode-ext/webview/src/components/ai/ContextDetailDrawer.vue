<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';

export interface ContextDetailState {
  schemaText: string;
  domainContext: string;
  defaultDirectives: string;
  commentCount: number;
  tableCount: number;
  totalTables: number;
}

const props = defineProps<{ detail: ContextDetailState | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
</script>

<template>
  <div class="ai-ctx-drawer">
    <div class="ai-ctx-head">
      <span>{{ t('wv.ai.context.detail') }}</span>
      <button class="ai-btn" @click="emit('close')">✕</button>
    </div>
    <div v-if="!props.detail" class="ai-ctx-empty">{{ t('wv.ai.context.loading') }}</div>
    <template v-else>
      <div class="ai-ctx-meta">
        {{ t('wv.ai.context.detailMeta', { tables: props.detail.tableCount, total: props.detail.totalTables, comments: props.detail.commentCount }) }}
      </div>
      <label class="ai-ctx-label">{{ t('wv.ai.context.schema') }}</label>
      <pre class="ai-ctx-pre">{{ props.detail.schemaText || t('wv.ai.context.empty') }}</pre>
      <label class="ai-ctx-label">{{ t('wv.ai.context.domain') }}</label>
      <pre class="ai-ctx-pre">{{ props.detail.domainContext || t('wv.ai.context.empty') }}</pre>
      <label class="ai-ctx-label">{{ t('wv.ai.context.directives') }}</label>
      <pre class="ai-ctx-pre">{{ props.detail.defaultDirectives || t('wv.ai.context.empty') }}</pre>
    </template>
  </div>
</template>

<style scoped>
.ai-ctx-drawer {
  border-right: 1px solid var(--vscode-panel-border);
  width: 320px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 6px 8px;
  gap: 4px;
}
.ai-ctx-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
  color: var(--vscode-descriptionForeground);
}
.ai-ctx-meta {
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  color: var(--vscode-descriptionForeground);
}
.ai-ctx-label {
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  color: var(--vscode-descriptionForeground);
  margin-top: 4px;
}
.ai-ctx-pre {
  margin: 0;
  overflow: auto;
  flex: 1;
  min-height: 60px;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
  padding: 6px;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap;
}
.ai-ctx-empty {
  color: var(--vscode-descriptionForeground);
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
</style>