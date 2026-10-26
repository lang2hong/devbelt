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
/** 新增行任务的条件语义是「本次新增」，不能复用增减类的措辞。 */
function labelKey(type: string): string {
  return props.kind === 'newRows' ? `monitor.cond.newRows.${type}` : `monitor.cond.${type}`;
}
const type = computed(() => props.modelValue?.type ?? '');
const needsValue = computed(() => conditionNeedsValue(type.value));
const percent = computed(() => type.value === 'changePercent');

function onType(event: Event): void {
  const next = (event.target as HTMLSelectElement).value;
  if (!next) { emit('update:modelValue', undefined); return; }
  if (next === 'anyChange') { emit('update:modelValue', { type: next }); return; }
  // 换类型就换回该类型的默认值：避免把「变化 ≥ 10%」的 10 带到「高于 10」上。
  const fallback = next === 'changePercent' ? 10 : 1;
  emit('update:modelValue', { type: next, value: fallback });
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
      <option v-for="option in types" :key="option" :value="option">{{ t(labelKey(option)) }}</option>
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
