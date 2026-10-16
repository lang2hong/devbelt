<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { BUSINESS_RULES_MAX_CHARS } from '../../../../src/ai/businessRules';

/**
 * 业务规则弹层：一个入口、两个多行文本框（业务术语 / 默认业务规则）。
 * UI 合并，存储键与提示词区块在 host 侧保持分离。
 *
 * - 文本框 maxlength 与 host 截断上限一致，避免保存时被静默截断；
 * - 「保存」仅在有改动时可用；Ctrl/Cmd+Enter 保存，Esc 关闭；
 * - 有未保存改动时关闭 → 先确认（保存 / 放弃 / 继续编辑）。
 */
const props = defineProps<{
  domainContext: string;
  defaultDirectives: string;
  connName?: string;
}>();
const emit = defineEmits<{
  close: [];
  save: [payload: { domainContext: string; defaultDirectives: string }];
}>();

const { t } = useI18n();
const domain = ref(props.domainContext);
const directives = ref(props.defaultDirectives);
// 基线 = 最近一次 host 快照；dirty 以基线为准。
const base = ref({ domain: props.domainContext, directives: props.defaultDirectives });
const confirmClose = ref(false);

const dirty = computed(() => domain.value !== base.value.domain || directives.value !== base.value.directives);

// host 快照更新（连接/作用域刷新、保存回显）：未编辑时跟随；编辑中不覆盖用户输入。
watch(
  () => [props.domainContext, props.defaultDirectives] as const,
  ([d, r]) => {
    const wasDirty = dirty.value;
    base.value = { domain: d, directives: r };
    if (!wasDirty) {
      domain.value = d;
      directives.value = r;
    }
  },
);

function requestClose(): void {
  if (dirty.value) {
    confirmClose.value = true;
    return;
  }
  emit('close');
}

function save(): void {
  if (!dirty.value) return;
  emit('save', { domainContext: domain.value, defaultDirectives: directives.value });
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    requestClose();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    save();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="ai-br-overlay" @click.self="requestClose">
    <div class="ai-br-dialog" role="dialog" :aria-label="t('wv.ai.rules.title')">
      <div class="ai-br-head">
        <span class="ai-br-title">{{ t('wv.ai.rules.title') }}<template v-if="props.connName"> · {{ props.connName }}</template></span>
        <button class="ai-btn" :aria-label="t('wv.ai.cancel')" @click="requestClose">✕</button>
      </div>

      <label class="ai-br-label" for="ai-br-domain">{{ t('wv.ai.rules.domain') }}</label>
      <textarea
        id="ai-br-domain"
        v-model="domain"
        class="ai-br-textarea"
        rows="6"
        :maxlength="BUSINESS_RULES_MAX_CHARS"
        :placeholder="t('wv.ai.rules.domainPlaceholder')"
      ></textarea>
      <div class="ai-br-count">{{ domain.length }} / {{ BUSINESS_RULES_MAX_CHARS }}</div>

      <label class="ai-br-label" for="ai-br-directives">{{ t('wv.ai.rules.directives') }}</label>
      <textarea
        id="ai-br-directives"
        v-model="directives"
        class="ai-br-textarea"
        rows="6"
        :maxlength="BUSINESS_RULES_MAX_CHARS"
        :placeholder="t('wv.ai.rules.directivesPlaceholder')"
      ></textarea>
      <div class="ai-br-count">{{ directives.length }} / {{ BUSINESS_RULES_MAX_CHARS }}</div>

      <div class="ai-br-hint">{{ t('wv.ai.rules.hint') }}</div>
      <div class="ai-br-footer">
        <button class="ai-btn" @click="requestClose">{{ t('wv.ai.cancel') }}</button>
        <button class="ai-btn ai-br-primary" :disabled="!dirty" @click="save">{{ t('wv.ai.notes.save') }}</button>
      </div>

      <div v-if="confirmClose" class="ai-br-confirm">
        <div>{{ t('wv.ai.rules.unsaved') }}</div>
        <div class="ai-br-confirm-actions">
          <button class="ai-btn ai-br-primary" @click="save(); confirmClose = false">{{ t('wv.ai.notes.save') }}</button>
          <button class="ai-btn" @click="emit('close')">{{ t('wv.ai.notes.discard') }}</button>
          <button class="ai-btn" @click="confirmClose = false">{{ t('wv.ai.rules.keepEditing') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-br-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.ai-br-dialog {
  position: relative;
  width: min(560px, 94vw);
  max-height: 88vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.ai-br-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--vscode-foreground);
}
.ai-br-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.ai-br-label {
  margin-top: 4px;
  color: var(--vscode-foreground);
}
.ai-br-textarea {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 4px 6px;
  font-family: inherit;
  font-size: inherit;
  resize: vertical;
}
.ai-br-count {
  align-self: flex-end;
  font-size: calc(var(--vscode-font-size, 13px) - 2px);
  color: var(--vscode-descriptionForeground);
}
.ai-br-hint {
  color: var(--vscode-descriptionForeground);
  opacity: 0.85;
}
.ai-br-footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 4px;
}
.ai-br-primary:not(:disabled) {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.ai-br-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.ai-br-confirm {
  position: absolute;
  inset: auto 12px 12px 12px;
  padding: 8px 10px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}
.ai-br-confirm-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
</style>
