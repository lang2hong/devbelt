<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChartSeries } from '../../../utils/chartInference';
import { CHART_PALETTE, fmtChartValue, PIE_HEIGHT, smartLabels, useChartTip } from './chartShared';

/**
 * 饼图（手写 SVG，零依赖）：环形图（中心显示总计）+ HTML 图例（标签/数值/占比，自适应宽度）。
 * 像素尺寸固定，不随面板宽度缩放；图例标签折叠公共前缀，完整值在悬停提示。
 */
const props = defineProps<{ xLabel: string; xValues: string[]; series: ChartSeries[] }>();

const SIZE = PIE_HEIGHT;
const C = SIZE / 2;
const R = SIZE / 2 - 6;
const R_IN = R * 0.58;

const totalRaw = computed(() => props.series[0]?.values.reduce((a, b) => a + Math.max(b, 0), 0) ?? 0);
const total = computed(() => Math.max(totalRaw.value, 1e-9));
const shortLabels = computed(() => smartLabels(props.xValues));

function arc(a0: number, a1: number): string {
  // 整圆（单扇区 100%）用两段半弧画
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${(C + r * Math.cos(a)).toFixed(2)},${(C + r * Math.sin(a)).toFixed(2)}`;
  return `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(R_IN, a1)} A${R_IN},${R_IN} 0 ${large} 0 ${p(R_IN, a0)} Z`;
}

const slices = computed(() => {
  const values = props.series[0]?.values ?? [];
  let acc = 0;
  return props.xValues.map((xv, i) => {
    const v = Math.max(values[i] ?? 0, 0);
    const a0 = (acc / total.value) * Math.PI * 2 - Math.PI / 2;
    acc += v;
    const a1 = (acc / total.value) * Math.PI * 2 - Math.PI / 2;
    return {
      full: xv,
      label: shortLabels.value[i]!,
      value: v,
      percent: (v / total.value) * 100,
      color: CHART_PALETTE[i % CHART_PALETTE.length]!,
      path: v > 0 ? arc(a0, a1) : '',
    };
  });
});

const hover = ref<number | null>(null);
const { tip, onEnter, onMove, onLeave } = useChartTip();
const tipText = (i: number): string => {
  const s = slices.value[i]!;
  return `${props.xLabel}: ${s.full}\n${props.series[0]?.label ?? ''}: ${s.value.toLocaleString()}（${s.percent.toFixed(1)}%）`;
};
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
  <div class="ai-chart-box ai-pie">
    <svg :width="SIZE" :height="SIZE" class="ai-chart-svg" role="img" :aria-label="`${xLabel} pie chart`">
      <path
        v-for="(s, si) in slices"
        :key="si"
        :d="s.path"
        :fill="s.color"
        class="ai-chart-slice"
        :class="{ dim: hover !== null && hover !== si }"
        @mouseenter="enter(si)($event)"
        @mousemove="onMove(() => tipText(si))($event)"
        @mouseleave="leave"
      />
      <text :x="C" :y="C - 2" class="ai-pie-total" text-anchor="middle">{{ fmtChartValue(totalRaw) }}</text>
      <text :x="C" :y="C + 15" class="ai-pie-caption" text-anchor="middle">{{ series[0]?.label }}</text>
    </svg>
    <ul class="ai-pie-legend">
      <li
        v-for="(s, si) in slices"
        :key="si"
        :class="{ on: hover === si }"
        :title="s.full"
        @mouseenter="hover = si"
        @mouseleave="hover = null"
      >
        <i :style="{ background: s.color }"></i>
        <span class="ai-pie-name">{{ s.label }}</span>
        <span class="ai-pie-val">{{ s.value.toLocaleString() }}</span>
        <span class="ai-pie-pct">{{ s.percent.toFixed(1) }}%</span>
      </li>
    </ul>
    <div v-if="tip" class="ai-chart-tip" :style="{ left: `${tip.x}px`, top: `${tip.y}px` }">{{ tip.text }}</div>
  </div>
</template>

<style scoped>
.ai-chart-box { position: relative; width: 100%; }
.ai-pie { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.ai-chart-svg { display: block; flex: none; font-family: var(--vscode-font-family, system-ui, sans-serif); }
.ai-chart-slice { stroke: var(--vscode-editor-background, #1e1e1e); stroke-width: 1.5; transition: opacity 0.12s; }
.ai-chart-slice.dim { opacity: 0.4; }
.ai-pie-total { fill: var(--vscode-foreground, #ccc); font-size: 18px; font-weight: 600; }
.ai-pie-caption { fill: var(--vscode-descriptionForeground, #888); font-size: 11px; }
.ai-pie-legend { list-style: none; margin: 0; padding: 0; min-width: 200px; max-width: 420px; flex: 1; max-height: 200px; overflow-y: auto; }
.ai-pie-legend li {
  display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 52px; align-items: center; gap: 8px;
  padding: 3px 6px; border-radius: 3px; font-size: 11.5px; color: var(--vscode-descriptionForeground, #888);
}
.ai-pie-legend li.on { background: rgba(125, 125, 125, 0.12); color: var(--vscode-foreground, #ccc); }
.ai-pie-legend i { width: 10px; height: 10px; border-radius: 2px; }
.ai-pie-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-pie-val { color: var(--vscode-foreground, #ccc); font-variant-numeric: tabular-nums; }
.ai-pie-pct { text-align: right; font-variant-numeric: tabular-nums; }
.ai-chart-tip {
  position: absolute; pointer-events: none; z-index: 5;
  transform: translate(12px, -50%);
  background: var(--vscode-editorHoverWidget-background, #252526);
  color: var(--vscode-editorHoverWidget-foreground, #ccc);
  border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
  border-radius: 4px; padding: 4px 8px; font-size: 11px; line-height: 1.5;
  white-space: pre; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
}
</style>
