<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import MessageBubble from './MessageBubble.vue';
import { useI18n } from '../../composables/useI18n';
import type { AiRunningPayload, AiToolResultPayload } from '../../utils/aiChatStream';

const props = defineProps<{
  messages: Array<{ role: 'user' | 'assistant'; content: string; error?: boolean; blockResults?: Record<number, AiToolResultPayload>; blockRunning?: Record<number, AiRunningPayload> }>;
  streaming: { content: string } | null;
  /** 当前连接引擎（用于代码块按引擎决定是否显示运行按钮）。 */
  dbType?: string;
}>();

const { t } = useI18n();
const scroller = ref<HTMLElement | null>(null);

watch(
  () => [props.messages.length, props.streaming?.content],
  async () => {
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div ref="scroller" class="ai-messages">
    <p v-if="messages.length === 0 && !streaming" class="ai-empty">{{ t('wv.ai.empty') }}</p>
    <MessageBubble v-for="(message, index) in messages" :key="index" :message="message" :db-type="props.dbType" :msg-idx="index" />
    <MessageBubble
      v-if="streaming"
      :message="{ role: 'assistant', content: streaming.content }"
      :db-type="props.dbType"
      streaming
    />
  </div>
</template>

<style scoped>
.ai-messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
}
.ai-empty {
  color: var(--vscode-descriptionForeground);
  text-align: center;
  margin-top: 24px;
}
</style>