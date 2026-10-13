<script setup lang="ts">
import { reactive } from 'vue';
import { useI18n } from '../../composables/useI18n';

export interface ContextDetailState {
  schemaText: string;
  domainContext: string;
  defaultDirectives: string;
  commentCount: number;
  tableCount: number;
  totalTables: number;
  /** 本次实际注入的表清单（SQL 引擎；其余引擎为空）。 */
  tables?: string[];
}

const props = defineProps<{ detail: ContextDetailState | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

/** 折叠面板（VSCode 视图风格）：表清单默认展开，其余默认折叠。 */
const open = reactive({ tables: true, schema: false, domain: false, directives: false });
type SectionKey = keyof typeof open;
function toggle(key: SectionKey): void {
  open[key] = !open[key];
}
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

      <div class="ai-ctx-section">
        <button class="ai-ctx-toggle" @click="toggle('tables')">
          <span class="ai-ctx-chevron">{{ open.tables ? '▾' : '▸' }}</span>
          <span>{{ t('wv.ai.context.tablesTitle') }}</span>
          <span class="ai-ctx-count">{{ props.detail.tables?.length ?? 0 }}</span>
        </button>
        <div v-show="open.tables" class="ai-ctx-scroll ai-ctx-list">
          <div v-for="name in props.detail.tables ?? []" :key="name" class="ai-ctx-item">{{ name }}</div>
          <div v-if="!(props.detail.tables?.length)" class="ai-ctx-empty">{{ t('wv.ai.context.empty') }}</div>
        </div>
      </div>

      <div class="ai-ctx-section">
        <button class="ai-ctx-toggle" @click="toggle('schema')">
          <span class="ai-ctx-chevron">{{ open.schema ? '▾' : '▸' }}</span>
          <span>{{ t('wv.ai.context.schema') }}</span>
        </button>
        <pre v-show="open.schema" class="ai-ctx-pre">{{ props.detail.schemaText || t('wv.ai.context.empty') }}</pre>
      </div>

      <div class="ai-ctx-section">
        <button class="ai-ctx-toggle" @click="toggle('domain')">
          <span class="ai-ctx-chevron">{{ open.domain ? '▾' : '▸' }}</span>
          <span>{{ t('wv.ai.context.domain') }}</span>
        </button>
        <pre v-show="open.domain" class="ai-ctx-pre">{{ props.detail.domainContext || t('wv.ai.context.empty') }}</pre>
      </div>

      <div class="ai-ctx-section">
        <button class="ai-ctx-toggle" @click="toggle('directives')">
          <span class="ai-ctx-chevron">{{ open.directives ? '▾' : '▸' }}</span>
          <span>{{ t('wv.ai.context.directives') }}</span>
        </button>
        <pre v-show="open.directives" class="ai-ctx-pre">{{ props.detail.defaultDirectives || t('wv.ai.context.empty') }}</pre>
      </div>
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
.ai-ctx-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.ai-ctx-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  padding: 2px 0;
  cursor: pointer;
  color: var(--vscode-foreground);
  font-family: inherit;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  text-align: left;
}
.ai-ctx-toggle:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12));
}
.ai-ctx-chevron {
  width: 12px;
  color: var(--vscode-descriptionForeground);
}
.ai-ctx-count {
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
}
.ai-ctx-scroll {
  overflow: auto;
  min-height: 0;
}
.ai-ctx-list {
  flex: 1;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 4px 6px;
}
.ai-ctx-item {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-ctx-pre {
  margin: 0;
  overflow: auto;
  flex: 1;
  min-height: 60px;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
  padding: 6px;
  font-size: var(--vscode-editor-font-size, 12px);
  font-family: var(--vscode-editor-font-family, monospace);
  white-space: pre-wrap;
}
.ai-ctx-empty {
  color: var(--vscode-descriptionForeground);
  font-size: calc(var(--vscode-font-size, 13px) - 1px);
}
</style>