<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChartSeries } from '../../../utils/chartInference';
import {
  CHART_HEIGHT,
  CHART_PALETTE,
  fitLabel,
  fmtChartValue,
  niceTicksRange,
  smartLabels,
  textWidth,
  useChartTip,
  useChartWidth,
} from './chartShared';

/**
 * 折线图（手写 SVG，零依赖）：按容器**实测宽度**绘制（字号恒定）；多序列多线 + 面积淡填充（单序列）+
 * 数据点（点少时）+ 点上数值（单序列且放得下）+ nice ticks（顶刻度 ≥ 最大值）+
 * x 标签公共前缀折叠/抽稀 + 竖向游标悬停（同一 x 的所有序列值）。
 */
const props = defineProps<{ xLabel: string; xValues: string[]; series: ChartSeries[]; area?: boolean }>();

const { el, width } = useChartWidth();
const H = CHART_HEIGHT;
const TOP = 20;
const BOTTOM = 24;
const plotH = H - TOP - BOTTOM;
const baseY = TOP + plotH;

// 折线允许负值：Y 轴覆盖 [min, max]，0 值处画轴线。柱/饼仍由推断层限制为非负。
const minV = computed(() => Math.min(0, ...props.series.flatMap((s) => s.values)));
const maxV = computed(() => Math.max(0, ...props.series.flatMap((s) => s.values)));
const ticks = computed(() => niceTicksRange(minV.value, maxV.value));
const yMin = computed(() => ticks.value[0] ?? 0);
const yMax = computed(() => ticks.value[ticks.value.length - 1] ?? 1);
const span = computed(() => yMax.value - yMin.value || 1);
const tickLabels = computed(() => ticks.value.map(fmtChartValue));
const left = computed(() => Math.ceil(Math.max(...tickLabels.value.map(textWidth))) + 12);
const right = 16;
const plotW = computed(() => Math.max(width.value - left.value - right, 40));

const n = computed(() => Math.max(props.xValues.length, 1));
/** 点放在等分槽中心（首尾不贴边，标签不被裁）。 */
const slotW = computed(() => plotW.value / n.value);
const x = (i: number): number => left.value + slotW.value * i + slotW.value / 2;
const y = (v: number): number => TOP + plotH - ((v - yMin.value) / span.value) * plotH;
const zeroY = computed(() => y(0));

const lines = computed(() =>
  props.series.map((s, si) => {
    const pts = s.values.map((v, i) => ({ cx: x(i), cy: y(v), value: v, label: fmtChartValue(v) }));
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
    const area = pts.length
      ? `${path} L${pts[pts.length - 1]!.cx.toFixed(1)},${zeroY.value.toFixed(1)} L${pts[0]!.cx.toFixed(1)},${zeroY.value.toFixed(1)} Z`
      : '';
    return { label: s.label, color: CHART_PALETTE[si % CHART_PALETTE.length]!, points: pts, path, area };
  }),
);

const showDots = computed(() => slotW.value >= 8);
const showValues = computed(() => {
  if (props.series.length !== 1) return false;
  const longest = Math.max(...lines.value[0]!.points.map((p) => textWidth(p.label)));
  return slotW.value >= longest + 6;
});

const shortLabels = computed(() => smartLabels(props.xValues));
const labelStep = computed(() => {
  const minPx = Math.min(Math.max(...shortLabels.value.map(textWidth)), 7 * 6.4);
  return Math.max(1, Math.ceil((minPx + 8) / slotW.value));
});
const xLabelText = (i: number): string => fitLabel(shortLabels.value[i]!, slotW.value * labelStep.value - 8);

const hover = ref<number | null>(null);
const { tip, onEnter, onMove, onLeave } = useChartTip();
const tipText = (i: number): string =>
  [`${props.xLabel}: ${props.xValues[i]}`, ...props.series.map((s) => `${s.label}: ${(s.values[i] ?? 0).toLocaleString()}`)].join('\n');
const enter = (i: number) => (e: MouseEvent) => {
  hover.value = i;
  onEnter(() => tipText(i))(e);
};
const leave = () => {
  hover.value = null;
  onLeave();
};
</script>

<template>
  <div ref="el" class="ai-chart-box">
    <div v-if="series.length > 1" class="ai-chart-legend">
      <span v-for="(line, si) in lines" :key="si" class="ai-chart-legend-item">
        <i :style="{ background: line.color }"></i>{{ line.label }}
      </span>
    </div>
    <svg :width="width" :height="H" class="ai-chart-svg" role="img" :aria-label="`${xLabel} line chart`">
      <g v-for="(t, ti) in ticks" :key="ti">
        <line :x1="left" :x2="width - right" :y1="y(t)" :y2="y(t)" :class="Math.abs(t) < 1e-9 ? 'ai-chart-axis' : 'ai-chart-grid'" />
        <text :x="left - 8" :y="y(t) + 4" class="ai-chart-tick" text-anchor="end">{{ tickLabels[ti] }}</text>
      </g>
      <line v-if="hover !== null" :x1="x(hover)" :x2="x(hover)" :y1="TOP" :y2="baseY" class="ai-chart-cursor" />
      <g v-for="(line, si) in lines" :key="si">
        <path v-if="series.length === 1" :d="line.area" :fill="line.color" class="ai-chart-area" :class="{ strong: area }" />
        <path :d="line.path" :stroke="line.color" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <template v-if="showDots">
          <circle
            v-for="(p, pi) in line.points"
            :key="pi"
            :cx="p.cx"
            :cy="p.cy"
            :r="hover === pi ? 4.5 : 3"
            :fill="line.color"
            class="ai-chart-dot"
          />
        </template>
        <template v-if="showValues">
          <text v-for="(p, pi) in line.points" :key="`v${pi}`" :x="p.cx" :y="p.value >= 0 ? p.cy - 8 : p.cy + 14" class="ai-chart-value" text-anchor="middle">{{ p.label }}</text>
        </template>
      </g>
      <template v-for="(xv, i) in xValues" :key="i">
        <text v-if="i % labelStep === 0" :x="x(i)" :y="H - 7" class="ai-chart-xlabel" :class="{ on: hover === i }" text-anchor="middle">{{ xLabelText(i) }}</text>
        <rect
          :x="left + slotW * i"
          :y="TOP"
          :width="slotW"
          :height="plotH"
          class="ai-chart-hit"
          @mouseenter="enter(i)($event)"
          @mousemove="onMove(() => tipText(i))($event)"
          @mouseleave="leave"
        />
      </template>
    </svg>
    <div v-if="tip" class="ai-chart-tip" :class="{ flip: tip.x > width - 200 }" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">{{ tip.text }}</div>
  </div>
</template>

<style scoped>
.ai-chart-box { position: relative; width: 100%; }
.ai-chart-svg { display: block; overflow: visible; font-family: var(--vscode-font-family, system-ui, sans-serif); }
.ai-chart-grid { stroke: rgba(125, 125, 125, 0.16); stroke-width: 1; stroke-dasharray: 3 3; }
.ai-chart-axis { stroke: rgba(125, 125, 125, 0.45); stroke-width: 1; }
.ai-chart-tick { fill: var(--vscode-descriptionForeground, #888); font-size: 11px; }
.ai-chart-area { opacity: 0.12; pointer-events: none; }
.ai-chart-area.strong { opacity: 0.28; }
.ai-chart-dot { pointer-events: none; stroke: var(--vscode-editor-background, #1e1e1e); stroke-width: 1.5; }
.ai-chart-cursor { stroke: rgba(125, 125, 125, 0.45); stroke-width: 1; stroke-dasharray: 3 3; }
.ai-chart-hit { fill: transparent; }
.ai-chart-value { fill: var(--vscode-foreground, #ccc); font-size: 11px; pointer-events: none; }
.ai-chart-xlabel { fill: var(--vscode-descriptionForeground, #888); font-size: 11px; pointer-events: none; }
.ai-chart-xlabel.on { fill: var(--vscode-foreground, #ccc); }
.ai-chart-legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 0 0 6px; }
.ai-chart-legend-item { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--vscode-descriptionForeground, #888); }
.ai-chart-legend-item i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.ai-chart-tip {
  position: absolute; pointer-events: none; z-index: 5;
  transform: translate(12px, -50%);
  background: var(--vscode-editorHoverWidget-background, #252526);
  color: var(--vscode-editorHoverWidget-foreground, #ccc);
  border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
  border-radius: 4px; padding: 4px 8px; font-size: 11px; line-height: 1.5;
  white-space: pre; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
}
.ai-chart-tip.flip { transform: translate(calc(-100% - 12px), -50%); }
</style>
