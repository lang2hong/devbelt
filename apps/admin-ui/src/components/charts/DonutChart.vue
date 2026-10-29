<script setup lang="ts">
import { computed } from 'vue';
import { chartColor } from './palette';
import { formatValue, type ValueKind } from './format';

/**
 * 环形图（内联 SVG，零依赖）。
 * 适合展示构成：设备平台、反馈状态/分类、营收构成。
 */
interface Item {
  label: string;
  value: number;
  color?: string;
}

const props = withDefaults(defineProps<{
  items: Item[];
  centerLabel?: string;
  kind?: ValueKind;
  emptyText?: string;
}>(), {
  centerLabel: '合计',
  kind: 'number',
  emptyText: '暂无数据。',
});

const total = computed(() => props.items.reduce((n, i) => n + Math.max(0, i.value), 0));

const segments = computed(() => {
  let cumulative = 0;
  return props.items
    .map((it, i) => ({ ...it, color: it.color ?? chartColor(i), value: Math.max(0, it.value) }))
    .filter((it) => it.value > 0)
    .map((it) => {
      const pct = total.value > 0 ? (it.value / total.value) * 100 : 0;
      const seg = { ...it, pct, dash: `${pct} ${100 - pct}`, offset: -cumulative };
      cumulative += pct;
      return seg;
    });
});

function pctLabel(value: number): string {
  if (total.value <= 0) return '0%';
  return `${((value / total.value) * 100).toFixed(value / total.value < 0.01 ? 1 : 0)}%`;
}
</script>

<template>
  <div class="donut">
    <template v-if="total > 0">
      <div class="ring-wrap">
        <svg viewBox="0 0 160 160" role="img" :aria-label="centerLabel">
          <circle class="ring-bg" cx="80" cy="80" r="56" />
          <circle
            v-for="s in segments"
            :key="s.label"
            class="ring-seg"
            cx="80"
            cy="80"
            r="56"
            pathLength="100"
            :stroke="s.color"
            :stroke-dasharray="s.dash"
            :stroke-dashoffset="s.offset"
            transform="rotate(-90 80 80)"
          >
            <title>{{ s.label }}：{{ formatValue(s.value, kind) }}（{{ pctLabel(s.value) }}）</title>
          </circle>
          <text class="center-value" x="80" y="78" text-anchor="middle">{{ formatValue(total, kind) }}</text>
          <text class="center-label" x="80" y="95" text-anchor="middle">{{ centerLabel }}</text>
        </svg>
      </div>
      <ul class="legend">
        <li v-for="s in segments" :key="s.label">
          <i class="dot" :style="{ background: s.color }" />
          <span class="label" :title="s.label">{{ s.label }}</span>
          <b>{{ formatValue(s.value, kind) }}</b>
          <span class="pct">{{ pctLabel(s.value) }}</span>
        </li>
      </ul>
    </template>
    <p v-else class="empty">{{ emptyText }}</p>
  </div>
</template>

<style scoped>
.donut { display: flex; align-items: center; gap: 16px; min-height: 150px; }
.ring-wrap { flex: 0 0 132px; }
.ring-wrap svg { width: 132px; height: 132px; display: block; }
.ring-bg { fill: none; stroke: var(--c-border); stroke-width: 18; }
.ring-seg { fill: none; stroke-width: 18; }
.center-value { fill: var(--c-text); font-size: 17px; font-weight: 700; }
.center-label { fill: var(--c-text-muted); font-size: 9px; }
.legend { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.legend li { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto auto; align-items: center; gap: 6px; font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 2px; }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-text-muted); }
.legend b { font-weight: 600; }
.pct { color: var(--c-text-subtle); min-width: 34px; text-align: right; }
.empty { width: 100%; padding: 28px 8px; text-align: center; color: var(--c-text-muted); font-size: 13px; }
@media (max-width: 520px) {
  .donut { flex-direction: column; align-items: stretch; }
  .ring-wrap { align-self: center; }
}
</style>