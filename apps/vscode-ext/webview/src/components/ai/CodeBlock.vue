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
</script>

<template>
  <div class="ai-code">
    <div class="ai-code-head">
      <span class="ai-code-lang">{{ lang || 'code' }}</span>
      <button class="ai-btn ai-code-copy" @click="copy">{{ copied ? t('wv.ai.copied') : t('wv.ai.copy') }}</button>
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