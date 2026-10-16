import { describe, expect, it } from 'vitest';
import { hasChartIntent, inferCharts } from '../../webview/src/utils/chartInference';

describe('hasChartIntent（图表意图关键词，中英）', () => {
  it('中文意图词命中', () => {
    expect(hasChartIntent('按月统计销量，用图表显示')).toBe(true);
    expect(hasChartIntent('各年龄段用户占比')).toBe(true);
    expect(hasChartIntent('看下每月的走势')).toBe(true);
    expect(hasChartIntent('画个柱状图')).toBe(true);
  });
  it('英文意图词命中（大小写不敏感）', () => {
    expect(hasChartIntent('show sales trend as a chart')).toBe(true);
    expect(hasChartIntent('Visualize monthly revenue')).toBe(true);
    expect(hasChartIntent('plot the distribution')).toBe(true);
  });
  it('普通提问不命中', () => {
    expect(hasChartIntent('统计各状态的数量')).toBe(false);
    expect(hasChartIntent('查询所有用户')).toBe(false);
    expect(hasChartIntent('')).toBe(false);
  });
});

describe('inferCharts（结果形态 → 图表规格）', () => {
  const monthRows = () => [
    ['2026-01', '1200', '300'],
    ['2026-02', '1,838', '450'],
    ['2026-03', '950', '280'],
  ];

  it('时间样 x + 多数值列 → 线优先 + 多序列（千分位可解析）', () => {
    const spec = inferCharts(['month', 'sales', 'orders'], monthRows());
    expect(spec).not.toBeNull();
    expect(spec!.types).toEqual(['line', 'bar']);
    expect(spec!.xLabel).toBe('month');
    expect(spec!.series).toHaveLength(2);
    expect(spec!.series[0]).toEqual({ label: 'sales', values: [1200, 1838, 950] });
    expect(spec!.series[1]).toEqual({ label: 'orders', values: [300, 450, 280] });
  });

  it('两列类别小额全正且非时间样 → 饼优先', () => {
    const spec = inferCharts(
      ['status', 'count'],
      [['active', '10'], ['pending', '5'], ['closed', '3']],
    );
    expect(spec!.types).toEqual(['pie', 'bar']);
    expect(spec!.series).toHaveLength(1);
  });

  it('类别 x 多行 → 柱优先', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`dept_${i}`, String(i * 10)]);
    const spec = inferCharts(['dept', 'total'], rows);
    expect(spec!.types).toEqual(['bar']);
  });

  it('全数值列（无类别轴）→ null；少于两列 → null；空行 → null', () => {
    expect(inferCharts(['a', 'b'], [['1', '2'], ['3', '4']])).toBeNull();
    expect(inferCharts(['only'], [['x']])).toBeNull();
    expect(inferCharts(['a', 'b'], [])).toBeNull();
  });

  it('饼资格：含非正数 → 不给饼；超 12 行 → 不给饼', () => {
    expect(inferCharts(['k', 'v'], [['a', '0'], ['b', '5']])!.types).not.toContain('pie');
    const rows = Array.from({ length: 13 }, (_, i) => [`k${i}`, '2']);
    expect(inferCharts(['k', 'v'], rows)!.types).not.toContain('pie');
  });

  it('负值：柱/线资格同时失效（fail-open 回表格，不把负值画成 0）', () => {
    // 两列混合正负：饼要求全正、柱/线要求全非负 → 无图型
    expect(inferCharts(['k', 'v'], [['a', '-5'], ['b', '3']])).toBeNull();
    // 时间样 + 负值：线/柱均不可用
    expect(inferCharts(['month', 'profit'], [['2026-01', '-5'], ['2026-02', '3']])).toBeNull();
    // 全非负（含 0）保持可用（两列时间样：线/柱可用，饼仍按全正口径追加）
    const spec = inferCharts(['month', 'sales'], monthRows())!;
    expect(spec.types).toContain('line');
    expect(spec.types).toContain('bar');
  });

  it('行上限：柱 > 60 行 → 无柱；线点 > 200 → 无线', () => {
    const rows = Array.from({ length: 61 }, (_, i) => [`c${i}`, '1']);
    const spec = inferCharts(['c', 'v'], rows);
    expect(spec).toBeNull(); // 无柱也无饼（>12 行）
    const timeRows = Array.from({ length: 201 }, (_, i) => [`2026-01-${String(i % 28 + 1).padStart(2, '0')}`, '1']);
    const spec2 = inferCharts(['date', 'v'], timeRows);
    expect(spec2).toBeNull();
  });

  it('首数值列不可解析的行被丢弃；全不可解析 → null', () => {
    // 列数值占比 3/4（≥70% 判数值列），行 a 的值 'x' 不可解析 → 该行弃用。
    const spec = inferCharts(['k', 'v'], [['a', 'x'], ['b', '5'], ['c', '7'], ['d', '9']]);
    expect(spec!.xValues).toEqual(['b', 'c', 'd']);
    expect(inferCharts(['k', 'v'], [['a', 'x'], ['b', 'y'], ['c', 'z'], ['d', 'w']])).toBeNull();
  });

  it('多序列上限 6（多余数值列忽略）', () => {
    const header = ['k', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
    const rows = [['a', '1', '2', '3', '4', '5', '6', '7', '8']];
    const spec = inferCharts(header, rows);
    expect(spec!.series).toHaveLength(6);
    expect(spec!.series.map((s) => s.label)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('列名带时间词即时间样（无需单元格可解析）', () => {
    const spec = inferCharts(['月份', 'v'], [['1月', '10'], ['2月', '20']]);
    expect(spec!.types[0]).toBe('line');
  });
});

describe('inferCharts（ID 列识别：雪花/手机号/编号不算度量）', () => {
  it('真机复现：tenant_id（19 位雪花）+ animal_count → 正常出图（饼/柱）', () => {
    const spec = inferCharts(
      ['tenant_id', 'animal_count'],
      [
        ['2060201405675302913', '168'],
        ['2085274117850251266', '849'],
        ['2085274632160002049', '821'],
      ],
    );
    expect(spec).not.toBeNull();
    expect(spec!.types).toEqual(['pie', 'bar']);
    expect(spec!.xLabel).toBe('tenant_id');
    expect(spec!.series[0]).toEqual({ label: 'animal_count', values: [168, 849, 821] });
  });

  it('列名 id/no/phone 等即使数字可解析也作类别列', () => {
    expect(inferCharts(['user_no', 'score'], [['1001', '88'], ['1002', '92']])!.xLabel).toBe('user_no');
    expect(inferCharts(['phone', 'cnt'], [['13800138000', '3'], ['13900139000', '5']])!.xLabel).toBe('phone');
    // 中文编号同理
    expect(inferCharts(['编号', '数量'], [['A001', '3'], ['A002', '5']])!.xLabel).toBe('编号');
  });

  it('指标名长数值仍是度量（amount 12 位不判 ID）', () => {
    const spec = inferCharts(['month', 'amount'], [['2026-01', '123456789012'], ['2026-02', '987654321012']]);
    expect(spec!.series[0]!.label).toBe('amount');
  });

  it('两列都是 ID 样 → 无度量 → null', () => {
    expect(inferCharts(['tenant_id', 'group_id'], [['2060201405675302913', '1001'], ['2085274117850251266', '1002']])).toBeNull();
  });
});

