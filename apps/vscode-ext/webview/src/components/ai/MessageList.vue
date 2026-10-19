<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MessageBubble from './MessageBubble.vue';
import { useI18n } from '../../composables/useI18n';
import type { AiRunningPayload, AiToolResultPayload } from '../../utils/aiChatStream';

const props = defineProps<{
  messages: Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string; error?: boolean; blockResults?: Record<number, AiToolResultPayload>; blockRunning?: Record<number, AiRunningPayload> }>;
  streaming: { content: string; reasoning: string } | null;
  /** 当前连接引擎（用于代码块按引擎决定是否显示运行按钮）。 */
  dbType?: string;
}>();

const { t } = useI18n();
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
  <div ref="scroller" class="ai-messages" @scroll.passive="onScroll">
    <div ref="content" class="ai-messages-inner">
      <p v-if="messages.length === 0 && !streaming" class="ai-empty">{{ t('wv.ai.empty') }}</p>
      <MessageBubble v-for="(message, index) in messages" :key="index" :message="message" :db-type="props.dbType" :msg-idx="index" />
      <MessageBubble
        v-if="streaming"
        :message="{ role: 'assistant', content: streaming.content, reasoning: streaming.reasoning }"
        :db-type="props.dbType"
        streaming
      />
    </div>
  </div>
</template>

<style scoped>
.ai-messages {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
}
.ai-messages-inner {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}
.ai-empty {
  color: var(--vscode-descriptionForeground);
  text-align: center;
  margin-top: 24px;
}
</style>