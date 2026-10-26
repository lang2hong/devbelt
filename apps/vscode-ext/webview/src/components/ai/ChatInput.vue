<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';

const model = defineModel<string>({ required: true });
const props = defineProps<{
  generating: boolean;
  /** Agent 开关（输入框下方的小开关；未选连接时不可用）。 */
  agentEnabled?: boolean;
  agentAvailable?: boolean;
}>();
const emit = defineEmits<{ send: []; stop: []; toggleAgent: [] }>();
const { t } = useI18n();
const box = ref<HTMLTextAreaElement | null>(null);
/**
 * 输入法正在组合文字（选候选词）。
 *
 * 组合期间的回车是「选词」，不能当成发送：Chromium 里这个 keydown 通常带
 * `isComposing` / `keyCode 229`，但有些输入法在 `compositionend` 之后才发 keydown，
 * 那时 `isComposing` 已经被置回 false，所以再用组合状态兜一层（延迟一拍清除，
 * 避免把紧跟其后的回车也吞掉）。
 */
const composing = ref(false);

function onCompositionStart(): void {
  composing.value = true;
}

function onCompositionEnd(): void {
  setTimeout(() => { composing.value = false; }, 0);
}

function resize(): void {
  const el = box.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

onMounted(() => void nextTick(resize));
watch(model, () => void nextTick(resize));

function onKeydown(event: KeyboardEvent): void {
  if (composing.value || event.isComposing || event.keyCode === 229) return;
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
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
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
    <div class="ai-input-foot">
      <button
        class="ai-agent-toggle"
        role="switch"
        :aria-checked="!!props.agentEnabled"
        :disabled="!props.agentAvailable || props.generating"
        :title="props.agentAvailable ? t('wv.ai.agent.hint') : t('wv.ai.agent.needConnection')"
        @click="emit('toggleAgent')"
      >
        <span class="ai-agent-knob" :class="{ on: props.agentEnabled }" aria-hidden="true"></span>
        <span>{{ t('wv.ai.agent.label') }}</span>
      </button>
      <p class="ai-input-hint">{{ t('wv.ai.input.hint') }}</p>
    </div>
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
.ai-input-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
}
.ai-input-foot .ai-input-hint { margin: 0; }
.ai-agent-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  cursor: pointer;
  padding: 2px 0;
}
.ai-agent-toggle:disabled { opacity: 0.5; cursor: default; }
.ai-agent-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.ai-agent-knob {
  position: relative;
  width: 24px;
  height: 12px;
  border-radius: 6px;
  background: var(--vscode-input-border, var(--vscode-panel-border));
  transition: background 0.15s;
}
.ai-agent-knob::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vscode-foreground);
  transition: left 0.15s;
}
.ai-agent-knob.on { background: var(--vscode-button-background); }
.ai-agent-knob.on::after { left: 14px; background: var(--vscode-button-foreground); }
</style>
