<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useVsCode } from '../../composables/useVsCode';
import { useI18n } from '../../composables/useI18n';
import { formatElapsed, isRunningSlow } from '../../../../src/ai/slowQuery';

/**
 * 代码块下方的「执行中」指示（P9：in-chat SQL 内联绑定后显示）：
 * 实时计时（以 host 开始时间为准）+ 取消按钮；超过阈值追加「较慢，可继续等待或取消」。
 * toolResult 到达（成功/失败/取消）由根组件清除本指示。
 */
const props = defineProps<{ runId: string; startedAt: number }>();

const { post } = useVsCode();
const { t } = useI18n();
const now = ref(Date.now());
const cancelling = ref(false);
const timer = window.setInterval(() => {
  now.value = Date.now();
}, 200);
onBeforeUnmount(() => window.clearInterval(timer));

const elapsed = computed(() => Math.max(0, now.value - props.startedAt));
const slow = computed(() => isRunningSlow(elapsed.value));

function cancel(): void {
  if (cancelling.value) return;
  cancelling.value = true;
  post({ type: 'cancelQuery', runId: props.runId });
}
</script>

<template>
  <div class="ai-running" role="status" aria-live="polite">
    <span class="ai-running-spin" aria-hidden="true"></span>
    <span class="ai-running-text">{{ t('wv.ai.run.running', { time: formatElapsed(elapsed) }) }}</span>
    <span v-if="slow" class="ai-running-slow">{{ t('wv.ai.run.slowHint') }}</span>
    <button class="ai-btn ai-running-cancel" :disabled="cancelling" @click="cancel">
      {{ cancelling ? t('wv.ai.run.cancelling') : t('wv.ai.run.cancel') }}
    </button>
  </div>
</template>

<style scoped>
.ai-running {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 10px;
  padding: 6px 10px;
  border-left: 3px solid var(--vscode-focusBorder, #0078d4);
  background: var(--vscode-editor-background, #1e1e1e);
  border-radius: 4px;
  font-size: 12.5px;
  color: var(--vscode-foreground, #ccc);
}
.ai-running-spin {
  width: 10px;
  height: 10px;
  border: 2px solid var(--vscode-descriptionForeground, #888);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ai-running-rot 0.9s linear infinite;
}
@keyframes ai-running-rot {
  to {
    transform: rotate(360deg);
  }
}
.ai-running-text {
  font-variant-numeric: tabular-nums;
}
.ai-running-slow {
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.ai-running-cancel {
  margin-left: auto;
}
</style>
