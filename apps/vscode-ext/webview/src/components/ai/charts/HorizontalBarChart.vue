<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChartSeries } from '../../../utils/chartInference';
import {
  CHART_HEIGHT,
  CHART_PALETTE,
  fitLabel,
  fmtChartValue,
  niceTicks,
  smartLabels,
  textWidth,
  useChartTip,
  useChartWidth,
} from './chartShared';

/**
 * 横向条形图（手写 SVG，零依赖）：分类在左、数值在右。
 *
 * 用于分类较多或标签较长的结果：固定 240px 的高度会挤压行距，因此高度随行数增长；
 * 多序列按分组横向柱展示，标签按可用宽度折叠/截断，悬停显示完整分类与各序列值。
 */
const props = defineProps<{ xLabel: string; xValues: string[]; series: ChartSeries[] }>();

const { el, width } = useChartWidth();
const H = computed(() => Math.max(CHART_HEIGHT, props.xValues.length * 26 + 44));
const TOP = 20;
const BOTTOM = 30;
const RIGHT = 16;

const maxV = computed(() => Math.max(1, ...props.series.flatMap((s) => s.values.map((v) => Math.abs(v)))));
const ticks = computed(() => niceTicks(maxV.value));
const xMax = computed(() => ticks.value[ticks.value.length - 1] || 1);
const tickLabels = computed(() => ticks.value.map(fmtChartValue));
const shortLabels = computed(() => smartLabels(props.xValues));
const left = computed(() => {
  const max = shortLabels.value.length ? Math.max(...shortLabels.value.map(textWidth)) : 0;
  return Math.min(180, Math.max(56, Math.ceil(max) + 10));
});
const plotW = computed(() => Math.max(width.value - left.value - RIGHT, 40));
const plotH = computed(() => Math.max(H.value - TOP - BOTTOM, 40));
const groupH = computed(() => plotH.value / Math.max(props.xValues.length, 1));
const barH = computed(() => {
  const k = Math.max(props.series.length, 1);
  return Math.max(2, Math.min((groupH.value * 0.7) / k, k === 1 ? 18 : 12));
});
const BAR_GAP = 2;

const x = (v: number): number => left.value + (Math.max(v, 0) / xMax.value) * plotW.value;

const groups = computed(() =>
  props.xValues.map((xv, gi) => {
    const gy = TOP + groupH.value * gi;
    const k = props.series.length;
    const span = barH.value * k + BAR_GAP * (k - 1);
    const start = gy + (groupH.value - span) / 2;
    return {
      x: xv,
      gy,
      cy: gy + groupH.value / 2,
      label: fitLabel(shortLabels.value[gi]!, left.value - 10),
      bars: props.series.map((s, si) => {
        const value = s.values[gi] ?? 0;
        return {
          value,
          label: fmtChartValue(value),
          color: CHART_PALETTE[si % CHART_PALETTE.length]!,
          y: start + (barH.value + BAR_GAP) * si,
          width: Math.max(0, x(value) - left.value),
        };
      }),
    };
  }),
);

const showValues = computed(() => barH.value >= 12 && plotW.value > 100);

const hover = ref<number | null>(null);
const { tip, onEnter, onMove, onLeave } = useChartTip();
const tipText = (gi: number): string => {
  const g = groups.value[gi]!;
  return [
    `${props.xLabel}: ${g.x}`,
    ...props.series.map((s) => `${s.label}: ${(s.values[gi] ?? 0).toLocaleString()}`),
  ].join('\n');
};
const enter = (gi: number) => (e: MouseEvent) => {
  hover.value = gi;
  onEnter(() => tipText(gi))(e);
};
const leave = () => {
  hover.value = null;
  onLeave();
};
</script>

<template>
  <div ref="el" class="ai-chart-box">
    <div v-if="series.length > 1" class="ai-chart-legend">
      <span v-for="(s, si) in series" :key="si" class="ai-chart-legend-item">
        <i :style="{ background: CHART_PALETTE[si % CHART_PALETTE.length] }"></i>{{ s.label }}
      </span>
    </div>
    <svg :width="width" :height="H" class="ai-chart-svg" role="img" :aria-label="`${xLabel} horizontal bar chart`">
      <g v-for="(t, ti) in ticks" :key="ti">
        <line :x1="x(t)" :x2="x(t)" :y1="TOP" :y2="H - BOTTOM" :class="ti === 0 ? 'ai-chart-axis' : 'ai-chart-grid'" />
        <text :x="x(t)" :y="H - 9" class="ai-chart-tick" text-anchor="middle">{{ tickLabels[ti] }}</text>
      </g>
      <g v-for="(g, gi) in groups" :key="gi">
        <rect
          :x="left"
          :y="g.gy"
          :width="plotW"
          :height="groupH"
          class="ai-chart-band"
          :class="{ on: hover === gi }"
          @mouseenter="enter(gi)($event)"
          @mousemove="onMove(() => tipText(gi))($event)"
          @mouseleave="leave"
        />
        <text :x="left - 8" :y="g.cy + 4" class="ai-chart-xlabel" :class="{ on: hover === gi }" text-anchor="end">{{ g.label }}</text>
        <template v-for="(b, bi) in g.bars" :key="bi">
          <rect v-if="b.width > 0" :x="left" :y="b.y" :width="b.width" :height="barH" :fill="b.color" rx="2" class="ai-chart-bar" />
          <text
            v-if="showValues && b.width > 0"
            :x="Math.min(left + b.width + 4, width - 4)"
            :y="b.y + barH / 2 + 4"
            :text-anchor="left + b.width + 56 > width ? 'end' : 'start'"
            class="ai-chart-value"
          >{{ b.label }}</text>
        </template>
      </g>
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
.ai-chart-band { fill: transparent; }
.ai-chart-band.on { fill: rgba(125, 125, 125, 0.1); }
.ai-chart-bar { pointer-events: none; }
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