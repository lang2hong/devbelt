<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { conditionNeedsValue, conditionTypes, type ConditionInput } from '../../utils/monitorView';

/**
 * 提醒条件编辑器（提案卡片与「后台任务」编辑共用）：
 * 类型从白名单里选，数值由用户填；没选类型时 `modelValue` 为 undefined。
 */
const props = defineProps<{
  modelValue?: ConditionInput;
  kind: 'rowCount' | 'metric' | 'newRows';
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: ConditionInput | undefined] }>();
const { t } = useI18n();

const types = computed(() => conditionTypes(props.kind));
const type = computed(() => props.modelValue?.type ?? '');
const needsValue = computed(() => conditionNeedsValue(type.value));
const percent = computed(() => type.value === 'changePercent');

function onType(event: Event): void {
  const next = (event.target as HTMLSelectElement).value;
  if (!next) { emit('update:modelValue', undefined); return; }
  if (next === 'anyChange') { emit('update:modelValue', { type: next }); return; }
  const fallback = percent.value ? 10 : 1;
  emit('update:modelValue', { type: next, value: props.modelValue?.value ?? fallback });
}

function onValue(event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  const value = raw.trim() === '' ? undefined : Number(raw);
  emit('update:modelValue', { type: type.value, ...(value !== undefined ? { value } : {}) });
}
</script>

<template>
  <span class="mce">
    <select class="mce-type" :value="type" :disabled="props.disabled" @change="onType">
      <option value="">{{ t('monitor.cond.pick') }}</option>
      <option v-for="option in types" :key="option" :value="option">{{ t(`monitor.cond.${option}`) }}</option>
    </select>
    <template v-if="needsValue">
      <input
        class="mce-value"
        type="number"
        :value="props.modelValue?.value ?? ''"
        :disabled="props.disabled"
        :aria-label="t('monitor.cond.value')"
        @input="onValue"
      />
      <span v-if="percent" class="mce-unit">%</span>
    </template>
  </span>
</template>

<style scoped>
.mce { display: inline-flex; align-items: center; gap: 4px; }
.mce-type, .mce-value {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent);
  border-radius: 3px;
  padding: 2px 6px;
  font: inherit;
}
.mce-value { width: 76px; }
.mce-unit { color: var(--vscode-descriptionForeground); }
</style>
