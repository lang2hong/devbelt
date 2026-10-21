import { describe, expect, it } from 'vitest';
import { formatCredits, formatCreditTokens } from '../../webview/src/utils/credits';

describe('credits 展示', () => {
  it('保留积分小数，不把小額消耗四舍五入成 0', () => {
    expect(formatCredits(0.001)).toBe('0.001');
    expect(formatCredits(0.1234)).toBe('0.123');
    expect(formatCredits(12.345)).toBe('12.345');
  });

  it('token → 积分按 1000 换算', () => {
    expect(formatCreditTokens(1)).toBe('0.001');
    expect(formatCreditTokens(1234)).toBe('1.234');
    expect(formatCreditTokens(1000)).toBe('1');
  });

  it('非法值显示占位符', () => {
    expect(formatCredits(Number.NaN)).toBe('—');
    expect(formatCreditTokens(Number.POSITIVE_INFINITY)).toBe('—');
  });
});