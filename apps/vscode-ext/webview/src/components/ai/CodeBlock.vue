<script setup lang="ts">
import { ref } from 'vue';
import { useVsCode } from '../../composables/useVsCode';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{ code: string; lang?: string }>();
const { post } = useVsCode();
const { t } = useI18n();
const copied = ref(false);

function copy(): void {
  post({ type: 'copyCode', text: props.code });
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1500);
}

/** P9 S4：应用到编辑器（活动 SQL 编辑器插入/替换；否则新 untitled 文档）。 */
function apply(): void {
  post({ type: 'applyCode', text: props.code });
}

/** P9 S4：执行（host 复用现有确认/只读/生产门禁；AI 永不自动执行）。 */
function execute(): void {
  post({ type: 'executeSql', text: props.code });
}
</script>

<template>
  <div class="ai-code">
    <div class="ai-code-head">
      <span class="ai-code-lang">{{ lang || 'code' }}</span>
      <div class="ai-code-actions">
        <button class="ai-btn ai-code-copy" @click="copy">{{ copied ? t('wv.ai.copied') : t('wv.ai.copy') }}</button>
        <button class="ai-btn" @click="apply">{{ t('wv.ai.insert') }}</button>
        <button class="ai-btn" @click="execute">{{ t('wv.ai.execute') }}</button>
      </div>
    </div>
    <pre class="ai-code-body"><code>{{ code }}</code></pre>
  </div>
</template>

<style scoped>
.ai-code {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  margin: 4px 0;
  overflow: hidden;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
}
.ai-code-actions {
  display: flex;
  gap: 4px;
}
.ai-code-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.ai-code-body {
  margin: 0;
  padding: 8px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  white-space: pre;
}
</style>