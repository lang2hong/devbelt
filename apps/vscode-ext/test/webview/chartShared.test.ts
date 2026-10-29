import { describe, expect, it } from 'vitest';
import { fitLabel, fmtChartValue, niceTicks, niceTicksRange, smartLabels } from '../../webview/src/components/ai/charts/chartMath';

describe('niceTicks（顶刻度必须 ≥ 最大值）', () => {
  it.each([16, 15, 550, 1838, 7, 1, 0.3, 99999])('max=%s', (max) => {
    const ticks = niceTicks(max);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(max);
    // 严格递增
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
  });

  it('典型步长：16 → 0..20，550 → 0..600', () => {
    expect(niceTicks(16)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(550)).toEqual([0, 200, 400, 600]);
  });

  it('max 恰为刻度时不多加一格', () => {
    expect(niceTicks(20)).toEqual([0, 5, 10, 15, 20]);
  });

  it('0 → [0, 1]', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe('smartLabels（公共前缀折叠）', () => {
  it('雪花 ID 共享高位 → 只留区分尾段', () => {
    const out = smartLabels(['2085274117850251266', '2085274632160002049', '2085274988310000001']);
    expect(out).toEqual(['…117850251266', '…632160002049', '…988310000001']);
    expect(new Set(out).size).toBe(3);
  });

  it('单号前缀（字母+数字）同样折叠', () => {
    expect(smartLabels(['ORD20261016001', 'ORD20261016002'])).toEqual(['…6001', '…6002']);
  });

  it('前缀过短（<4）或普通文本 → 原样', () => {
    expect(smartLabels(['北京', '上海', '广州'])).toEqual(['北京', '上海', '广州']);
    expect(smartLabels(['abc1', 'abc2'])).toEqual(['abc1', 'abc2']);
  });

  it('长度不一：保留至少 4 个区分字符', () => {
    const out = smartLabels(['10000001', '1000000123']);
    for (const s of out) expect(s.replace('…', '').length).toBeGreaterThanOrEqual(4);
  });

  it('单项 / 空 → 原样（trim）', () => {
    expect(smartLabels([' 2085274117850251266 '])).toEqual(['2085274117850251266']);
    expect(smartLabels([])).toEqual([]);
  });
});

describe('fitLabel / fmtChartValue', () => {
  it('放得下原样，放不下尾部省略', () => {
    expect(fitLabel('abc', 100)).toBe('abc');
    const cut = fitLabel('abcdefghijklmnopqrstuvwxyz', 40);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan(26);
  });

  it('折叠前缀的标签截断时保留尾段', () => {
    const cut = fitLabel('…117850251266', 50);
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('266')).toBe(true);
  });

  it('大数压缩、去尾零', () => {
    expect(fmtChartValue(1838)).toBe('1838');
    expect(fmtChartValue(12000)).toBe('12K');
    expect(fmtChartValue(2_500_000)).toBe('2.5M');
    expect(fmtChartValue(1.5)).toBe('1.5');
  });
});

describe('niceTicksRange（跨 0 的折线轴）', () => {
  it('同时覆盖负值与正值，且包含 0', () => {
    const ticks = niceTicksRange(-12, 40);
    expect(ticks[0]).toBeLessThanOrEqual(-12);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(40);
    expect(ticks).toContain(0);
  });

  it('全负/全正也包含 0，步长单调递增', () => {
    for (const [lo, hi] of [[-9, -1], [1, 9], [-0.4, 0.4]] as const) {
      const ticks = niceTicksRange(lo, hi);
      expect(ticks[0]).toBeLessThanOrEqual(lo);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(hi);
      expect(ticks).toContain(0);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    }
  });
});
