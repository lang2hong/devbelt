<script setup lang="ts">
import { computed } from 'vue';
import { chartColor } from './palette';
import { formatAxis, formatValue, type ValueKind } from './format';

/**
 * 按天柱状图（内联 SVG，零依赖）。
 * - 单序列：每日新增用户、每日 AI tokens；
 * - 多序列 + stacked：每日营收（套餐 + AI 充值）。
 */
interface Series {
  key: string;
  label: string;
  color?: string;
}

type Point = { day: string } & Record<string, string | number>;

const props = withDefaults(defineProps<{
  points: Point[];
  series: Series[];
  stacked?: boolean;
  kind?: ValueKind;
  emptyText?: string;
}>(), {
  stacked: false,
  kind: 'number',
  emptyText: '暂无数据。',
});

const W = 760;
const H = 230;
const M = { top: 14, right: 12, bottom: 30, left: 52 };
const INNER_W = W - M.left - M.right;
const INNER_H = H - M.top - M.bottom;

const seriesList = computed(() => props.series.map((s, i) => ({ ...s, color: s.color ?? chartColor(i) })));

function valueOf(p: Point, key: string): number {
  const n = Number(p[key] ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const hasData = computed(() => props.points.some((p) => seriesList.value.some((s) => valueOf(p, s.key) > 0)));

const yMax = computed(() => {
  const raw = Math.max(0, ...props.points.map((p) => {
    const values = seriesList.value.map((s) => valueOf(p, s.key));
    return props.stacked ? values.reduce((a, b) => a + b, 0) : Math.max(0, ...values);
  }));
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
});

const slot = computed(() => INNER_W / Math.max(1, props.points.length));

function x(i: number): number {
  return M.left + slot.value * (i + 0.5);
}

function y(v: number): number {
  return M.top + INNER_H * (1 - v / yMax.value);
}

const barWidth = computed(() => {
  if (props.stacked || seriesList.value.length <= 1) return Math.max(2, slot.value * 0.62);
  return Math.max(2, (slot.value * 0.72) / seriesList.value.length);
});

const bars = computed(() => {
  const out: Array<{ key: string; x: number; y: number; w: number; h: number; color: string; value: number; label: string; day: string }> = [];
  props.points.forEach((p, i) => {
    let cumulative = 0;
    seriesList.value.forEach((s, si) => {
      const value = valueOf(p, s.key);
      if (value <= 0) return;
      let bx: number;
      let by: number;
      let bh: number;
      if (props.stacked) {
        bx = x(i) - barWidth.value / 2;
        by = y(cumulative + value);
        bh = y(cumulative) - by;
        cumulative += value;
      } else {
        const groupW = barWidth.value * seriesList.value.length;
        bx = x(i) - groupW / 2 + si * barWidth.value;
        by = y(value);
        bh = M.top + INNER_H - by;
      }
      out.push({
        key: `${p.day}-${s.key}`,
        x: bx,
        y: by,
        w: barWidth.value,
        h: Math.max(0, bh),
        color: s.color,
        value,
        label: s.label,
        day: p.day,
      });
    });
  });
  return out;
});

const totals = computed(() => seriesList.value.map((s) => ({
  ...s,
  total: props.points.reduce((n, p) => n + valueOf(p, s.key), 0),
})));

const yTicks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((r) => ({
  value: yMax.value * r,
  y: M.top + INNER_H * (1 - r),
})));

const xTicks = computed(() => props.points
  .map((p, i) => ({ day: p.day, i }))
  .filter(({ i }) => i % 5 === 0 || i === props.points.length - 1)
  .map(({ day, i }) => ({ day, x: x(i) })));
</script>

<template>
  <figure class="chart">
    <figcaption class="legend-bar">
      <span v-for="s in totals" :key="s.key" class="legend">
        <i class="dot" :style="{ background: s.color }" />
        {{ s.label }}<b>{{ formatValue(s.total, kind) }}</b>
      </span>
    </figcaption>

    <p v-if="!hasData" class="empty">{{ emptyText }}</p>

    <svg v-else class="plot" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="近 30 天趋势">
      <g class="grid">
        <line v-for="(t, i) in yTicks" :key="i" :x1="M.left" :x2="W - M.right" :y1="t.y" :y2="t.y" />
        <text v-for="(t, i) in yTicks" :key="`l-${i}`" :x="M.left - 8" :y="t.y + 4" text-anchor="end">{{ formatAxis(t.value, kind) }}</text>
      </g>
      <g class="bars">
        <rect v-for="b in bars" :key="b.key" :x="b.x" :y="b.y" :width="b.w" :height="b.h" :fill="b.color" rx="1.5">
          <title>{{ b.day }} · {{ b.label }}：{{ formatValue(b.value, kind) }}</title>
        </rect>
      </g>
      <g class="x-axis">
        <text v-for="t in xTicks" :key="t.day" :x="t.x" :y="H - 8" text-anchor="middle">{{ t.day.slice(5) }}</text>
      </g>
    </svg>

    <details v-if="hasData" class="table-wrap">
      <summary>查看数据表</summary>
      <table>
        <thead>
          <tr><th>日期（UTC）</th><th v-for="s in seriesList" :key="s.key">{{ s.label }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in points" :key="p.day">
            <td>{{ p.day }}</td>
            <td v-for="s in seriesList" :key="s.key">{{ formatValue(valueOf(p, s.key), kind) }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>

<style scoped>
.chart { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.legend-bar { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--c-text-muted); font-size: 12px; }
.legend { display: inline-flex; align-items: center; gap: 6px; }
.legend b { color: var(--c-text); font-weight: 600; margin-left: 2px; }
.dot { width: 9px; height: 9px; border-radius: 2px; }
.plot { width: 100%; height: auto; display: block; }
.grid line { stroke: var(--c-border-strong); stroke-width: 1; }
.grid text, .x-axis text { fill: var(--c-text-muted); font-size: 10px; }
.empty { padding: 28px 8px; text-align: center; color: var(--c-text-muted); font-size: 13px; }
.table-wrap { font-size: 12px; color: var(--c-text-muted); }
.table-wrap summary { cursor: pointer; }
.table-wrap table { width: 100%; border-collapse: collapse; margin-top: 6px; }
.table-wrap th, .table-wrap td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--c-border-strong); }
</style>