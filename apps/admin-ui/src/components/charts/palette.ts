/** 图表统一色板；SVG fill/stroke 直接使用 CSS 变量与十六进制。 */
export const CHART_COLORS = [
  'var(--c-accent)',
  '#3aa675',
  '#d9ad2b',
  '#d6303f',
  '#8b5cf6',
  '#0ea5e9',
  '#f97316',
  '#64748b',
] as const;

export function chartColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]!;
}