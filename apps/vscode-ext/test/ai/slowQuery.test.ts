import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  isRunningSlow,
  isSlowQuery,
  RUNNING_SLOW_HINT_MS,
  SLOW_QUERY_MS,
} from '../../src/ai/slowQuery';

describe('slowQuery', () => {
  it('isSlowQuery：阈值含边界；非数值/缺省 → false', () => {
    expect(isSlowQuery(SLOW_QUERY_MS)).toBe(true);
    expect(isSlowQuery(SLOW_QUERY_MS - 1)).toBe(false);
    expect(isSlowQuery(undefined)).toBe(false);
    expect(isSlowQuery(Number.NaN)).toBe(false);
  });

  it('isRunningSlow：执行中提示阈值', () => {
    expect(isRunningSlow(RUNNING_SLOW_HINT_MS - 1)).toBe(false);
    expect(isRunningSlow(RUNNING_SLOW_HINT_MS)).toBe(true);
  });

  it('formatElapsed：<10s 一位小数，≥10s 取整，非法值按 0', () => {
    expect(formatElapsed(1234)).toBe('1.2s');
    expect(formatElapsed(9999)).toBe('10.0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(-5)).toBe('0.0s');
    expect(formatElapsed(Number.NaN)).toBe('0.0s');
  });
});
