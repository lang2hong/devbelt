<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MessageBubble from './MessageBubble.vue';
import { useI18n } from '../../composables/useI18n';
import type { AiRunningPayload, AiToolResultPayload } from '../../utils/aiChatStream';
import type { AiMessageUsage } from '../../../../src/ai/aiSessionStore';

const props = defineProps<{
  messages: Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string; error?: boolean; usage?: AiMessageUsage; blockResults?: Record<number, AiToolResultPayload>; blockRunning?: Record<number, AiRunningPayload> }>;
  streaming: { content: string; reasoning: string } | null;
  /** Agent 模式的步骤（运行中显示在流式气泡上方）。 */
  agentSteps?: Array<{ index: number; tool: string; status: 'running' | 'ok' | 'error'; summary?: string; durationMs?: number; errorCode?: string }>;
  /** 当前连接引擎（用于代码块按引擎决定是否显示运行按钮）。 */
  dbType?: string;
  /** 空状态建议问题；点击只填入输入框。 */
  suggestions?: string[];
}>();

const emit = defineEmits<{
  (e: 'copy', text: string): void;
  (e: 'suggest', text: string): void;
  (e: 'regenerate'): void;
  (e: 'edit', index: number, text: string): void;
}>();

const { t } = useI18n();
const stepStatusKey = {
  running: 'wv.ai.agent.step.running',
  ok: 'wv.ai.agent.step.ok',
  error: 'wv.ai.agent.step.error',
} as const;
const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);

/** 距底阈值：用户上翻超过该距离即视为"离开底部"，不再自动跟随。 */
const STICK_THRESHOLD_PX = 48;
const stick = ref(true);

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
}

async function jumpToBottom(): Promise<void> {
  stick.value = true;
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 仅在底部跟随：内容/思考过程增量与异步渲染高度变化都走这里。 */
async function stickToBottom(): Promise<void> {
  if (!stick.value) return;
  await nextTick();
  const el = scroller.value;
  if (el && stick.value) el.scrollTop = el.scrollHeight;
}

watch(
  () => [props.messages.length, props.streaming?.content, props.streaming?.reasoning],
  () => void stickToBottom(),
);

// 图表/代码块/图片等异步渲染会继续增高——观察内容容器高度，在底部时持续贴底。
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !content.value) return;
  observer = new ResizeObserver(() => void stickToBottom());
  observer.observe(content.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="ai-messages-wrap">
    <div ref="scroller" class="ai-messages" @scroll.passive="onScroll">
      <div ref="content" class="ai-messages-inner">
        <div v-if="messages.length === 0 && !streaming" class="ai-empty">
          <span class="ai-empty-spark ai-gradient-text" aria-hidden="true">✦</span>
          <p class="ai-empty-text ai-gradient-text">{{ t('wv.ai.empty') }}</p>
          <div v-if="props.suggestions && props.suggestions.length" class="ai-suggestions">
            <button v-for="s in props.suggestions" :key="s" class="ai-btn" @click="emit('suggest', s)">{{ s }}</button>
          </div>
        </div>
        <MessageBubble
          v-for="(message, index) in messages"
          :key="index"
          :message="message"
          :db-type="props.dbType"
          :msg-idx="index"
          :can-edit="message.role === 'user'"
          :can-regenerate="index === messages.length - 1 && message.role === 'assistant'"
          @copy="emit('copy', $event)"
          @regenerate="emit('regenerate')"
          @edit="emit('edit', index, message.content)"
        />
        <div v-if="streaming && props.agentSteps && props.agentSteps.length" class="ai-agent-steps">
          <div v-for="step in props.agentSteps" :key="step.index" class="ai-agent-step" :class="step.status">
            <span class="ai-agent-step-dot"></span>
            <span class="ai-agent-step-name">{{ step.index }}. {{ step.tool }}</span>
            <span class="ai-agent-step-status">{{ t(stepStatusKey[step.status]) }}</span>
            <span v-if="step.summary" class="ai-agent-step-summary">{{ step.summary }}</span>
          </div>
        </div>
        <MessageBubble
          v-if="streaming"
          :message="{ role: 'assistant', content: streaming.content, reasoning: streaming.reasoning }"
          :db-type="props.dbType"
          streaming
          @copy="emit('copy', $event)"
        />
      </div>
    </div>
    <button v-if="!stick" class="ai-jump" :title="t('wv.ai.jumpBottom')" @click="jumpToBottom">
      ↓ {{ t('wv.ai.jumpBottom') }}
    </button>
  </div>
</template>

<style scoped>
.ai-messages-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.ai-messages {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  padding: 10px 14px;
}
.ai-messages-inner {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}
.ai-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: 12vh;
  text-align: center;
}
.ai-empty-spark {
  font-size: 28px;
  line-height: 1;
}
.ai-empty-text {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.ai-suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: 560px;
  margin-top: 12px;
}
.ai-suggestions .ai-btn {
  background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.15));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
}
.ai-jump {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  z-index: 5;
  padding: 5px 14px;
  border-radius: 999px;
  border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
  background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
  cursor: pointer;
  font-size: 12px;
}

.ai-agent-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 6px 2px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.ai-agent-step {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.ai-agent-step-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--vscode-descriptionForeground);
}
.ai-agent-step.running .ai-agent-step-dot { background: var(--vscode-progressBar-background, #0e70c0); }
.ai-agent-step.ok .ai-agent-step-dot { background: var(--vscode-testing-iconPassed, #2ea043); }
.ai-agent-step.error .ai-agent-step-dot { background: var(--vscode-errorForeground, #f48771); }
.ai-agent-step-name { color: var(--vscode-foreground); }
.ai-agent-step-summary { opacity: 0.8; }
</style>