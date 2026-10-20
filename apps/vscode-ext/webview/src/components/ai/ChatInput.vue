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
      rows="2"
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
  position: relative;
  margin: 6px 12px 12px;
}
.ai-input-box {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 64px;
  max-height: 200px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent));
  border-radius: 22px;
  padding: 12px 96px 12px 18px;
  font-family: inherit;
  font-size: calc(var(--vscode-font-size, 13px) + 1px);
  line-height: 1.5;
}
.ai-input-box:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}
.ai-input-actions {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 6px;
}
</style>