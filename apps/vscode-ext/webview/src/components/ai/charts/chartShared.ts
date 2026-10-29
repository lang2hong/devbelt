import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** 图表共享：色板 / 轴刻度 / 数值格式 / 标签 / 实测宽度 / 悬停提示。 */

/** 6 色循环色板（VS Code 风格亮色，深浅背景均可读）。 */
export const CHART_PALETTE = ['#4fc1ff', '#ffd166', '#06d6a0', '#ef476f', '#b392f0', '#f78c6c'];

/** 通用图表高度（真实像素，不随宽度缩放）。 */
export const CHART_HEIGHT = 240;
export const PIE_HEIGHT = 200;
/** 宽度量不到（首帧/隐藏）时的回退宽度。 */
export const FALLBACK_WIDTH = 720;

// 纯函数在 chartMath.ts（DOM 无关、可单测），此处转导出供组件沿用原导入路径。
export { fitLabel, fmtChartValue, niceTicks, niceTicksRange, smartLabels, textWidth } from './chartMath';

/** 容器实测宽度（ResizeObserver）：图表按真实像素绘制，字号不随宽度缩放。 */
export function useChartWidth(): { el: Ref<HTMLElement | null>; width: Ref<number> } {
  const el = ref<HTMLElement | null>(null);
  const width = ref(FALLBACK_WIDTH);
  let ro: ResizeObserver | null = null;
  const measure = (): void => {
    const w = el.value?.clientWidth ?? 0;
    if (w > 0) width.value = Math.floor(w);
  };
  onMounted(() => {
    measure();
    if (typeof ResizeObserver !== 'undefined' && el.value) {
      ro = new ResizeObserver(measure);
      ro.observe(el.value);
    }
  });
  onBeforeUnmount(() => ro?.disconnect());
  return { el, width };
}

/** 悬停提示（容器相对定位；单一 div 跟随鼠标）。 */
export interface ChartTipState {
  x: number;
  y: number;
  text: string;
}

export function useChartTip() {
  const tip = ref<ChartTipState | null>(null);
  const place = (e: MouseEvent, text: string): void => {
    const host = (e.currentTarget as Element | null)?.closest('.ai-chart-box') as HTMLElement | null;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    tip.value = { x: e.clientX - rect.left, y: e.clientY - rect.top, text };
  };
  const onEnter = (text: () => string) => (e: MouseEvent) => place(e, text());
  const onMove = (text: () => string) => (e: MouseEvent) => place(e, text());
  const onLeave = () => {
    tip.value = null;
  };
  return { tip, onEnter, onMove, onLeave };
}
