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
 * 柱状图（手写 SVG，零依赖）：按容器**实测宽度**绘制（字号恒定 11px，不随面板缩放）；
 * 多序列分组柱 + 顶值标注（放得下才显示）+ nice ticks（顶刻度 ≥ 最大值）+
 * 水平 x 标签（公共前缀折叠 + 按宽截断 + 放不下时抽稀）+ 分组悬停高亮与提示。
 * 轴名不画在图内：标题行「指标 by 维度」已说明含义。
 */
const props = defineProps<{ xLabel: string; xValues: string[]; series: ChartSeries[]; stacked?: boolean }>();

const { el, width } = useChartWidth();
const H = CHART_HEIGHT;

const maxV = computed(() => {
  if (props.stacked) {
    return Math.max(1, ...props.xValues.map((_, gi) =>
      props.series.reduce((sum, s) => sum + Math.max(s.values[gi] ?? 0, 0), 0)));
  }
  return Math.max(1, ...props.series.flatMap((s) => s.values.map((v) => Math.abs(v))));
});
const ticks = computed(() => niceTicks(maxV.value));
const yMax = computed(() => ticks.value[ticks.value.length - 1] || 1);
const tickLabels = computed(() => ticks.value.map(fmtChartValue));

const PAD = computed(() => ({
  top: 20,
  right: 12,
  bottom: 24,
  left: Math.ceil(Math.max(...tickLabels.value.map(textWidth))) + 12,
}));
const plotW = computed(() => Math.max(width.value - PAD.value.left - PAD.value.right, 40));
const plotH = H - 20 - 24;
const baseY = 20 + plotH;
const y = (v: number): number => 20 + plotH - (Math.max(v, 0) / yMax.value) * plotH;

const n = computed(() => Math.max(props.xValues.length, 1));
const groupW = computed(() => plotW.value / n.value);
const barW = computed(() => {
  const k = props.stacked ? 1 : props.series.length;
  const cap = k === 1 ? 56 : 36;
  return Math.max(2, Math.min((groupW.value * 0.7) / k, cap));
});
const BAR_GAP = 2;

/** 顶部圆角柱（底边直角）。 */
function barPath(x: number, top: number, w: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(3, w / 2, h);
  return `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${top + h} Z`;
}

const groups = computed(() =>
  props.xValues.map((xv, gi) => {
    const gx = PAD.value.left + groupW.value * gi;
    const cx = gx + groupW.value / 2;
    if (props.stacked) {
      const bw = barW.value;
      const start = gx + (groupW.value - bw) / 2;
      let acc = 0;
      const bars = props.series.map((s, si) => {
        const value = Math.max(s.values[gi] ?? 0, 0);
        const base = acc;
        acc += value;
        const top = y(acc);
        return {
          value,
          label: fmtChartValue(value),
          color: CHART_PALETTE[si % CHART_PALETTE.length]!,
          x: start,
          cx: start + bw / 2,
          top,
          path: barPath(start, top, bw, y(base) - top),
        };
      });
      return { x: xv, gx, cx, bars, total: acc, totalLabel: fmtChartValue(acc), totalTop: y(acc) };
    }
    const k = props.series.length;
    const span = barW.value * k + BAR_GAP * (k - 1);
    const start = gx + (groupW.value - span) / 2;
    return {
      x: xv,
      gx,
      cx,
      bars: props.series.map((s, si) => {
        const value = s.values[gi] ?? 0;
        const bx = start + (barW.value + BAR_GAP) * si;
        const top = y(value);
        return {
          value,
          label: fmtChartValue(value),
          color: CHART_PALETTE[si % CHART_PALETTE.length]!,
          x: bx,
          cx: bx + barW.value / 2,
          top,
          path: barPath(bx, top, barW.value, baseY - top),
        };
      }),
      total: 0,
      totalLabel: '',
      totalTop: 0,
    };
  }),
);

/** 顶值标注：每根柱宽 ≥ 最长数值文本宽才显示（多序列也显示，小值也能直接读）。 */
const showValues = computed(() => {
  if (props.stacked) return false;
  const longest = Math.max(...groups.value.flatMap((g) => g.bars.map((b) => textWidth(b.label))));
  return barW.value + BAR_GAP >= longest * 0.92;
});
const showStackTotal = computed(() => !!props.stacked && barW.value >= 14);

/** x 标签：公共前缀折叠 → 放不下就抽稀（每 step 个显示一个）→ 按可用宽截断。 */
const shortLabels = computed(() => smartLabels(props.xValues));
const labelStep = computed(() => {
  const minPx = Math.min(Math.max(...shortLabels.value.map(textWidth)), 7 * 6.4);
  return Math.max(1, Math.ceil((minPx + 8) / groupW.value));
});
const xLabelText = (i: number): string => fitLabel(shortLabels.value[i]!, groupW.value * labelStep.value - 8);

const hover = ref<number | null>(null);
const { tip, onEnter, onMove, onLeave } = useChartTip();
const tipText = (gi: number): string => {
  const g = groups.value[gi]!;
  const lines = g.bars.map((b, bi) => `${props.series[bi]!.label}: ${b.value.toLocaleString()}`);
  if (props.stacked) lines.push(`Total: ${g.total.toLocaleString()}`);
  return [`${props.xLabel}: ${g.x}`, ...lines].join('\n');
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
    <svg :width="width" :height="H" class="ai-chart-svg" role="img" :aria-label="`${xLabel} ${stacked ? 'stacked ' : ''}bar chart`">
      <g v-for="(t, ti) in ticks" :key="ti">
        <line :x1="PAD.left" :x2="width - PAD.right" :y1="y(t)" :y2="y(t)" :class="ti === 0 ? 'ai-chart-axis' : 'ai-chart-grid'" />
        <text :x="PAD.left - 8" :y="y(t) + 4" class="ai-chart-tick" text-anchor="end">{{ tickLabels[ti] }}</text>
      </g>
      <g v-for="(g, gi) in groups" :key="gi">
        <rect
          :x="g.gx"
          :y="20"
          :width="groupW"
          :height="plotH"
          class="ai-chart-band"
          :class="{ on: hover === gi }"
          @mouseenter="enter(gi)($event)"
          @mousemove="onMove(() => tipText(gi))($event)"
          @mouseleave="leave"
        />
        <path v-for="(b, bi) in g.bars" :key="bi" :d="b.path" :fill="b.color" class="ai-chart-bar" :class="{ dim: hover !== null && hover !== gi }" />
        <template v-if="showValues">
          <text v-for="(b, bi) in g.bars" :key="`v${bi}`" :x="b.cx" :y="b.top - 5" class="ai-chart-value" text-anchor="middle">{{ b.label }}</text>
        </template>
        <text v-if="showStackTotal && g.total > 0" :x="g.cx" :y="g.totalTop - 5" class="ai-chart-value" text-anchor="middle">{{ g.totalLabel }}</text>
        <text
          v-if="gi % labelStep === 0"
          :x="g.cx"
          :y="H - 7"
          class="ai-chart-xlabel"
          :class="{ on: hover === gi }"
          text-anchor="middle"
        >{{ xLabelText(gi) }}</text>
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
.ai-chart-bar { pointer-events: none; transition: opacity 0.12s; }
.ai-chart-bar.dim { opacity: 0.45; }
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
