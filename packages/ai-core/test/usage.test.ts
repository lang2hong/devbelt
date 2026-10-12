import { describe, expect, it } from 'vitest';
import { addUsage, estimateTokens, withinAiQuota } from '../src/usage.js';

describe('addUsage', () => {
  it('逐项累加', () => {
    expect(
      addUsage(
        { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      ),
    ).toEqual({ promptTokens: 11, completionTokens: 22, totalTokens: 33 });
  });
});

describe('estimateTokens', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('英文按 4 字符 ≈ 1 token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('CJK 按 1 字符 ≈ 1 token（不低估中文）', () => {
    expect(estimateTokens('中文')).toBe(2);
    expect(estimateTokens('中文abcd')).toBe(3);
  });
});

describe('withinAiQuota', () => {
  it('未取到配额或 0 → fail-closed 拒绝（0 不是“不限”）', () => {
    expect(withinAiQuota(undefined, 0)).toBe(false);
    expect(withinAiQuota(0, 0)).toBe(false);
  });

  it('未超限放行，达到上限拒绝', () => {
    expect(withinAiQuota(100, 99)).toBe(true);
    expect(withinAiQuota(100, 100)).toBe(false);
    expect(withinAiQuota(100, 101)).toBe(false);
  });
});