/**
 * 结果图表数据转换（宽表 → 多系列）。
 *
 * 语义：X 轴一列；Y 轴可多选 N 个数值列，**每列自动成为一个系列**（Series=按列），
 * 无需把宽表先转成长表。聚合模式下按 X 分组，每个 Y 列分别聚合。
 */

export type ChartAggregate = 'sum' | 'avg' | 'count' | 'max' | 'min' | 'none';

export interface ChartSeriesData {
  /** 系列名（列名，或 `agg 聚合(列名)`）。 */
  label: string;
  values: number[];
}

export interface ChartBuildResult {
  labels: string[];
  series: ChartSeriesData[];
}

/** 单元格 → 数值：容忍逗号千分位与百分号等导出格式；失败返回 undefined。 */
export function parseChartNumber(cell: unknown): number | undefined {
  if (cell === null || cell === undefined) return undefined;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  const cleaned = String(cell).trim().replace(/,/g, '').replace(/%$/, '');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function aggregateValues(vals: number[], agg: ChartAggregate): number {
  switch (agg) {
    case 'sum': return vals.reduce((a, b) => a + b, 0);
    case 'avg': return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'count': return vals.length;
    case 'max': return vals.length === 0 ? 0 : Math.max(...vals);
    case 'min': return vals.length === 0 ? 0 : Math.min(...vals);
    default: return vals.length > 0 ? vals[0] : 0;
  }
}

/**
 * 宽表 → 图表数据。
 *
 * - `agg === 'none'`：每行一个标签（X 列直接转字符串），每个 yKey 一列 → 一个系列；
 * - 聚合模式：按 X 分组，每个 yKey 在各组内分别聚合（sum/avg/count/max/min）。
 * - X 单元格为 null/undefined → 标签 ''（与旧行为一致，不丢行）。
 */
export function buildChartData(
  rows: Record<string, unknown>[],
  xKey: string,
  yKeys: string[],
  agg: ChartAggregate,
): ChartBuildResult {
  if (!xKey || yKeys.length === 0 || rows.length === 0) return { labels: [], series: [] };

  const series: ChartSeriesData[] = yKeys.map((y) => ({
    label: agg === 'none' ? y : `${agg}(${y})`,
    values: [] as number[],
  }));

  if (agg === 'none') {
    const labels = rows.map((r) => String(r[xKey] ?? ''));
    for (const r of rows) {
      yKeys.forEach((y, i) => {
        series[i].values.push(parseChartNumber(r[y]) ?? 0);
      });
    }
    return { labels, series };
  }

  // 聚合：组内每个 Y 列分别收集，再统一求值。
  type Group = { order: number; byColumn: number[][] };
  const order = new Map<string, Group>();
  for (const r of rows) {
    const key = String(r[xKey] ?? '');
    if (!order.has(key)) order.set(key, { order: order.size, byColumn: yKeys.map(() => []) });
    const g = order.get(key)!;
    yKeys.forEach((y, i) => {
      const v = parseChartNumber(r[y]);
      if (v !== undefined) g.byColumn[i].push(v);
    });
  }
  const sorted = [...order.entries()];
  // 保持首次出现顺序（聚合图表按出现顺序更直观）。
  const labels = sorted.map(([k]) => k);
  for (const [, g] of sorted) {
    yKeys.forEach((_y, i) => {
      series[i].values.push(aggregateValues(g.byColumn[i], agg));
    });
  }
  return { labels, series };
}