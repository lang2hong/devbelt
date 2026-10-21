<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';

const model = defineModel<string>({ required: true });
const props = defineProps<{ generating: boolean }>();
const emit = defineEmits<{ send: []; stop: [] }>();
const { t } = useI18n();
const box = ref<HTMLTextAreaElement | null>(null);

function resize(): void {
  const el = box.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

onMounted(() => void nextTick(resize));
watch(model, () => void nextTick(resize));

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('send');
  }
}
</script>

<template>
  <div class="ai-input">
    <div class="ai-input-field">
      <textarea
        ref="box"
        v-model="model"
        class="ai-input-box"
        rows="1"
        :placeholder="t('wv.ai.input.placeholder')"
        :disabled="props.generating"
        @keydown="onKeydown"
        @input="resize"
      ></textarea>
      <div class="ai-input-actions">
        <button v-if="props.generating" class="ai-btn ai-btn-primary" @click="emit('stop')">
          {{ t('wv.ai.stop') }}
        </button>
        <button v-else class="ai-btn ai-btn-primary" :disabled="!model.trim()" @click="emit('send')">
          {{ t('wv.ai.send') }}
        </button>
      </div>
    </div>
    <p class="ai-input-hint">{{ t('wv.ai.input.hint') }}</p>
  </div>
</template>

<style scoped>
.ai-input {
  margin: 6px 12px 12px;
}
.ai-input-field {
  position: relative;
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
  padding: 12px 116px 12px 18px;
  font-family: inherit;
  font-size: calc(var(--vscode-font-size, 13px) + 1px);
  line-height: 1.5;
}
.ai-input-box:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}
.ai-input-box:disabled { opacity: 0.75; }
.ai-input-hint {
  margin: 4px 0 0 18px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.ai-input-actions {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 6px;
}
.ai-input-actions .ai-btn {
  min-width: 92px;
  height: 36px;
  padding: 0 20px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
}
</style>