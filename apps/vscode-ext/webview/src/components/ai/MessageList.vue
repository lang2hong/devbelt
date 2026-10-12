<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import MessageBubble from './MessageBubble.vue';
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  messages: Array<{ role: 'user' | 'assistant'; content: string; error?: boolean }>;
  streaming: { content: string } | null;
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
    <MessageBubble v-for="(message, index) in messages" :key="index" :message="message" />
    <MessageBubble
      v-if="streaming"
      :message="{ role: 'assistant', content: streaming.content }"
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