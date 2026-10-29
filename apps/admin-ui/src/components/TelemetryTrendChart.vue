<script setup lang="ts">
import { computed } from 'vue';

/**
 * 安装/活跃趋势图（内联 SVG，零依赖）。
 *
 * - 柱形 = 每日新安装（首次激活）；
 * - 折线 = 每日活跃安装（按 install_id 去重的心跳）；
 * - 数据来自 `/api/admin/overview` 的 `telemetry.daily`，服务端已补齐 30 天并全部为 UTC 日期。
 */
interface TrendPoint {
  day: string;
  newInstalls: number;
  activeInstalls: number;
}

const props = defineProps<{ points: TrendPoint[] }>();

const W = 760;
const H = 260;
const M = { top: 16, right: 14, bottom: 32, left: 44 };
const INNER_W = W - M.left - M.right;
const INNER_H = H - M.top - M.bottom;

const hasData = computed(() => props.points.some((p) => p.newInstalls > 0 || p.activeInstalls > 0));

/** 取“好看”的 Y 轴上限：1/2/5 × 10^n。 */
const yMax = computed(() => {
  const raw = Math.max(1, ...props.points.map((p) => Math.max(p.newInstalls, p.activeInstalls)));
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

const bars = computed(() => props.points.map((p, i) => ({
  key: p.day,
  x: x(i) - slot.value * 0.28,
  y: y(p.newInstalls),
  w: Math.max(2, slot.value * 0.56),
  h: Math.max(0, M.top + INNER_H - y(p.newInstalls)),
  value: p.newInstalls,
  day: p.day,
})));

const linePoints = computed(() => props.points
  .map((p, i) => `${x(i).toFixed(1)},${y(p.activeInstalls).toFixed(1)}`)
  .join(' '));

const dots = computed(() => props.points.map((p, i) => ({
  key: p.day,
  cx: x(i),
  cy: y(p.activeInstalls),
  value: p.activeInstalls,
  day: p.day,
})));

const yTicks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((r) => ({
  value: Math.round(yMax.value * r),
  y: M.top + INNER_H * (1 - r),
})));

/** 每 5 天一个 X 标签，最后一天必标。 */
const xTicks = computed(() => props.points
  .map((p, i) => ({ day: p.day, i }))
  .filter(({ i }) => i % 5 === 0 || i === props.points.length - 1)
  .map(({ day, i }) => ({ day, x: x(i) })));

const totalNew = computed(() => props.points.reduce((n, p) => n + p.newInstalls, 0));
const totalActiveDays = computed(() => props.points.reduce((n, p) => n + p.activeInstalls, 0));

function shortDay(day: string): string {
  return day.slice(5);
}
</script>

<template>
  <figure class="chart">
    <figcaption class="chart-caption">
      <span class="legend"><i class="swatch new" />新安装</span>
      <span class="legend"><i class="swatch active" />活跃安装</span>
      <span class="summary">
        近 30 天新安装 {{ totalNew }}，活跃安装日累计 {{ totalActiveDays }}
      </span>
    </figcaption>

    <p v-if="!hasData" class="empty">暂无数据。安装与活跃数据会在扩展上报心跳后出现。</p>

    <svg
      v-else
      class="plot"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      aria-label="近 30 天每日新安装与活跃安装趋势"
    >
      <g class="grid">
        <line v-for="(t, i) in yTicks" :key="i" :x1="M.left" :x2="W - M.right" :y1="t.y" :y2="t.y" />
        <text v-for="(t, i) in yTicks" :key="`l-${i}`" :x="M.left - 8" :y="t.y + 4" text-anchor="end">{{ t.value }}</text>
      </g>

      <g class="bars">
        <rect
          v-for="b in bars"
          :key="b.key"
          :x="b.x"
          :y="b.y"
          :width="b.w"
          :height="b.h"
          rx="2"
        >
          <title>{{ b.day }}：新安装 {{ b.value }}</title>
        </rect>
      </g>

      <polyline class="active-line" :points="linePoints" />
      <g class="dots">
        <circle v-for="d in dots" :key="d.key" :cx="d.cx" :cy="d.cy" r="2.5">
          <title>{{ d.day }}：活跃 {{ d.value }}</title>
        </circle>
      </g>

      <g class="x-axis">
        <text v-for="t in xTicks" :key="t.day" :x="t.x" :y="H - 10" text-anchor="middle">{{ shortDay(t.day) }}</text>
      </g>
    </svg>

    <details v-if="hasData" class="table-wrap">
      <summary>查看数据表</summary>
      <table>
        <thead><tr><th>日期（UTC）</th><th>新安装</th><th>活跃安装</th></tr></thead>
        <tbody>
          <tr v-for="p in points" :key="p.day">
            <td>{{ p.day }}</td>
            <td>{{ p.newInstalls }}</td>
            <td>{{ p.activeInstalls }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>

<style scoped>
.chart { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.chart-caption { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; font-size: 12px; color: var(--c-text-muted); }
.legend { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.swatch.new { background: var(--c-accent); opacity: .55; }
.swatch.active { background: #3aa675; }
.summary { margin-left: auto; }
.empty { margin: 12px 0; padding: 24px 12px; text-align: center; color: var(--c-text-muted); font-size: 13px; border: 1px dashed var(--c-border-strong); border-radius: 6px; }
.plot { width: 100%; height: auto; display: block; }
.grid line { stroke: var(--c-border-strong); stroke-width: 1; }
.grid text, .x-axis text { fill: var(--c-text-muted); font-size: 10px; }
.bars rect { fill: var(--c-accent); opacity: .55; }
.active-line { fill: none; stroke: #3aa675; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dots circle { fill: #3aa675; }
.table-wrap { font-size: 12px; color: var(--c-text-muted); }
.table-wrap summary { cursor: pointer; }
.table-wrap table { width: 100%; border-collapse: collapse; margin-top: 6px; }
.table-wrap th, .table-wrap td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--c-border-strong); }
</style>