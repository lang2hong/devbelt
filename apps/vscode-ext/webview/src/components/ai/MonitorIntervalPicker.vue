<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { MIN_INTERVAL_MS, MAX_INTERVAL_MS } from '../../../../src/monitor/monitorTypes';

/**
 * 监控间隔选择：数值 + 单位（秒 / 分钟 / 小时），支持自定义间隔。
 * 对外只收发毫秒，取值会被夹到 [MIN_INTERVAL_MS, MAX_INTERVAL_MS]。
 */
const props = defineProps<{ modelValue: number; disabled?: boolean; /** 卡片上只留输入框，隐藏范围和快捷项。 */ compact?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();
const { t } = useI18n();

type Unit = 's' | 'm' | 'h';
const UNITS: Array<{ unit: Unit; factor: number; label: string }> = [
  { unit: 's', factor: 1000, label: 's' },
  { unit: 'm', factor: 60_000, label: 'm' },
  { unit: 'h', factor: 3_600_000, label: 'h' },
];

/** 选中的单位：默认取能整除的最大单位（10 秒 → 秒，5 分钟 → 分钟，1 小时 → 小时）。 */
function bestUnit(ms: number): Unit {
  if (ms % 3_600_000 === 0) return 'h';
  if (ms % 60_000 === 0) return 'm';
  return 's';
}

const unit = ref<Unit>(bestUnit(props.modelValue));
const amount = ref<number>(props.modelValue / factorOf(unit.value));

function factorOf(u: Unit): number {
  return UNITS.find((x) => x.unit === u)!.factor;
}

watch(() => props.modelValue, (ms) => {
  // 外部改值（例如换任务）时重新落位，避免停留在一个对不上的单位。
  if (Math.round(amount.value * factorOf(unit.value)) === ms) return;
  unit.value = bestUnit(ms);
  amount.value = ms / factorOf(unit.value);
});

const minText = computed(() => formatMs(MIN_INTERVAL_MS));
const maxText = computed(() => formatMs(MAX_INTERVAL_MS));

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('monitor.unit.seconds', { n: s });
  const m = Math.round((s / 60) * 10) / 10;
  if (m < 60) return t('monitor.unit.minutes', { n: m });
  return t('monitor.unit.hours', { n: Math.round((m / 60) * 10) / 10 });
}

function clamp(ms: number): number {
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

function apply(next: number): void {
  emit('update:modelValue', clamp(next));
}

function onAmount(event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    amount.value = props.modelValue / factorOf(unit.value);
    return;
  }
  const clamped = clamp(n * factorOf(unit.value));
  amount.value = n;
  apply(clamped);
  // 被夹到边界（或与原值相同）时把输入框拉回真实值，避免显示 5 秒却按 10 秒生效。
  if (clamped !== n * factorOf(unit.value)) amount.value = clamped / factorOf(unit.value);
}

function onUnit(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as Unit;
  unit.value = next;
  apply(amount.value * factorOf(next));
}

const presets = [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
</script>

<template>
  <span class="mip" :class="{ disabled: props.disabled }">
    <input
      class="mip-amount"
      type="number"
      min="1"
      step="1"
      :value="Math.round(amount * 100) / 100"
      :disabled="props.disabled"
      :aria-label="t('monitor.interval.amount')"
      @change="onAmount"
    />
    <select class="mip-unit" :value="unit" :disabled="props.disabled" :aria-label="t('monitor.interval.unit')" @change="onUnit">
      <option v-for="u in UNITS" :key="u.unit" :value="u.unit">{{ t(`monitor.unit.${u.unit}`) }}</option>
    </select>
    <span v-if="!props.compact" class="mip-hint">{{ t('monitor.interval.range', { min: minText, max: maxText }) }}</span>
    <span v-if="!props.compact" class="mip-presets">
      <button
        v-for="ms in presets"
        :key="ms"
        type="button"
        class="mip-preset"
        :class="{ on: ms === props.modelValue }"
        :disabled="props.disabled"
        @click="apply(ms)"
      >
        {{ formatMs(ms) }}
      </button>
    </span>
  </span>
</template>

<style scoped>
.mip { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mip-amount, .mip-unit {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent);
  border-radius: 3px;
  padding: 2px 6px;
  font: inherit;
}
.mip-amount { width: 72px; }
.mip-hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
.mip-presets { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.mip-preset {
  border: 1px solid var(--vscode-panel-border, transparent);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  border-radius: 10px;
  padding: 0 8px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.mip-preset:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.mip-preset.on { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
.mip.disabled { opacity: 0.6; }
</style>