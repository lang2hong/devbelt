<script setup lang="ts">
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';
import { parseInlineSegments, parseMessageBlocks, type AiInlineSegment } from '../../utils/aiChatStream';

const props = defineProps<{
  message: { role: 'user' | 'assistant'; content: string; error?: boolean };
  streaming?: boolean;
}>();

const blocks = computed(() => parseMessageBlocks(props.message.content));

function segments(text: string): AiInlineSegment[] {
  return parseInlineSegments(text);
}
</script>

<template>
  <div
    class="ai-bubble"
    :class="{
      'ai-bubble-user': message.role === 'user',
      'ai-bubble-assistant': message.role === 'assistant',
      'ai-bubble-error': message.error,
    }"
  >
    <template v-if="message.role === 'assistant' && !message.error">
      <template v-for="(block, index) in blocks" :key="index">
        <CodeBlock v-if="block.type === 'code'" :code="block.content" :lang="block.lang" />
        <p v-else class="ai-text">
          <template v-for="(seg, segIndex) in segments(block.content)" :key="segIndex">
            <code v-if="seg.type === 'code'" class="ai-inline-code">{{ seg.content }}</code>
            <span v-else>{{ seg.content }}</span>
          </template>
        </p>
      </template>
      <span v-if="streaming" class="ai-cursor">▍</span>
    </template>
    <p v-else class="ai-text">{{ message.content }}</p>
  </div>
</template>

<style scoped>
.ai-bubble {
  padding: 6px 10px;
  border-radius: 6px;
  margin: 4px 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.ai-bubble-user {
  background: var(--vscode-input-background, rgba(128, 128, 128, 0.15));
  align-self: flex-end;
}
.ai-bubble-assistant {
  background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
}
.ai-bubble-error {
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  color: var(--vscode-errorForeground, #f48771);
}
.ai-text {
  margin: 0;
  white-space: pre-wrap;
}
.ai-inline-code {
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
  padding: 0 3px;
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
}
.ai-cursor {
  animation: ai-blink 1s steps(2, start) infinite;
}
@keyframes ai-blink {
  to {
    visibility: hidden;
  }
}
</style>