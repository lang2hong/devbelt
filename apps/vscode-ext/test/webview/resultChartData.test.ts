import { describe, expect, it } from 'vitest';
import { buildChartData, parseChartNumber } from '../../webview/src/utils/resultChartData';

const wideRows = [
  { month: '2026-01', a: 10, b: 200, c: 1.5 },
  { month: '2026-02', a: 12, b: 180, c: 2.5 },
  { month: '2026-03', a: 9, b: 160, c: 3 },
];

describe('parseChartNumber', () => {
  it('容忍字符串数字、千分位与百分号', () => {
    expect(parseChartNumber('1,234')).toBe(1234);
    expect(parseChartNumber('12.5%')).toBe(12.5);
    expect(parseChartNumber(7)).toBe(7);
    expect(parseChartNumber('')).toBeUndefined();
    expect(parseChartNumber(null)).toBeUndefined();
    expect(parseChartNumber('abc')).toBeUndefined();
  });
});

describe('buildChartData（宽表 → 多系列）', () => {
  it('宽表多选 Y 列：每列自动成为一个系列，按列语义无需转置', () => {
    const { labels, series } = buildChartData(wideRows, 'month', ['a', 'b', 'c'], 'none');
    expect(labels).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(series).toHaveLength(3);
    expect(series[0]).toEqual({ label: 'a', values: [10, 12, 9] });
    expect(series[1]).toEqual({ label: 'b', values: [200, 180, 160] });
    expect(series[2]).toEqual({ label: 'c', values: [1.5, 2.5, 3] });
  });

  it('X 列可以是任何列（月份只是例子）', () => {
    const { labels } = buildChartData(wideRows, 'a', ['b'], 'none');
    expect(labels).toEqual(['10', '12', '9']);
  });

  it('聚合模式：按 X 分组，每个 Y 列分别聚合', () => {
    const rows = [
      { d: 'x', v1: 1, v2: 10 },
      { d: 'x', v1: 3, v2: 20 },
      { d: 'y', v1: 5, v2: 30 },
    ];
    const { labels, series } = buildChartData(rows, 'd', ['v1', 'v2'], 'sum');
    expect(labels).toEqual(['x', 'y']);
    expect(series[0]).toEqual({ label: 'sum(v1)', values: [4, 5] });
    expect(series[1]).toEqual({ label: 'sum(v2)', values: [30, 30] });

    const avg = buildChartData(rows, 'd', ['v1'], 'avg');
    expect(avg.series[0].values).toEqual([2, 5]);
  });

  it('count 统计组内行数（含 NULL / 文本行），不是可解析数值的个数', () => {
    const rows = [
      { g: 'a', v: 1 },
      { g: 'a', v: 'oops' },
      { g: 'a', v: null },
      { g: 'b', v: 2 },
    ];
    expect(buildChartData(rows, 'g', ['v'], 'count').series[0].values).toEqual([3, 1]);
  });

  it('count/max/min 聚合', () => {
    const rows = [
      { g: 'a', v: 2 },
      { g: 'a', v: 8 },
      { g: 'b', v: 5 },
    ];
    expect(buildChartData(rows, 'g', ['v'], 'count').series[0].values).toEqual([2, 1]);
    expect(buildChartData(rows, 'g', ['v'], 'max').series[0].values).toEqual([8, 5]);
    expect(buildChartData(rows, 'g', ['v'], 'min').series[0].values).toEqual([2, 5]);
  });

  it('非数值单元格按 0 处理（与旧行为一致，不丢行）', () => {
    const rows = [
      { d: 'a', v: 5 },
      { d: 'b', v: 'oops' },
      { d: 'c', v: null },
    ];
    const { series, labels } = buildChartData(rows, 'd', ['v'], 'none');
    expect(labels).toEqual(['a', 'b', 'c']);
    expect(series[0].values).toEqual([5, 0, 0]);
  });

  it('空输入安全', () => {
    expect(buildChartData([], 'x', ['y'], 'none')).toEqual({ labels: [], series: [] });
    expect(buildChartData(wideRows, '', ['a'], 'none')).toEqual({ labels: [], series: [] });
    expect(buildChartData(wideRows, 'month', [], 'none')).toEqual({ labels: [], series: [] });
  });
});