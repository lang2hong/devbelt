<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';

const model = defineModel<string>({ required: true });
const props = defineProps<{ generating: boolean }>();
const emit = defineEmits<{ send: [] }>();
const { t } = useI18n();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('send');
  }
}
</script>

<template>
  <div class="ai-input">
    <textarea
      v-model="model"
      class="ai-input-box"
      rows="3"
      :placeholder="t('wv.ai.input.placeholder')"
      :disabled="props.generating"
      @keydown="onKeydown"
    ></textarea>
    <div class="ai-input-actions">
      <button v-if="props.generating" class="ai-btn" @click="emit('send')" disabled>
        {{ t('wv.ai.generating') }}
      </button>
      <button v-else class="ai-btn ai-btn-primary" :disabled="!model.trim()" @click="emit('send')">
        {{ t('wv.ai.send') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ai-input {
  padding: 6px 10px 10px;
  border-top: 1px solid var(--vscode-panel-border);
}
.ai-input-box {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 13px;
}
.ai-input-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
</style>