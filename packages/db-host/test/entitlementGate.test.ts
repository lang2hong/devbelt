import { describe, expect, it } from 'vitest';
import { maxAiTokensMonthly, maxAuthenticatorEntries, DEFAULT_FREE_MAX_AUTH_ENTRIES } from '../src/sync/entitlementGate.js';

describe('maxAuthenticatorEntries', () => {
  it('returns the configured value when present and ≥0', () => {
    expect(maxAuthenticatorEntries({ maxAuthenticatorEntries: 1000 } as any)).toBe(1000);
  });

  it('fail-closed to default (10) when entitlement undefined', () => {
    expect(maxAuthenticatorEntries(undefined)).toBe(DEFAULT_FREE_MAX_AUTH_ENTRIES);
  });

  it('fail-closed to default when field missing', () => {
    expect(maxAuthenticatorEntries({} as any)).toBe(DEFAULT_FREE_MAX_AUTH_ENTRIES);
  });

  it('fail-closed to default for negative values', () => {
    expect(maxAuthenticatorEntries({ maxAuthenticatorEntries: -1 } as any)).toBe(DEFAULT_FREE_MAX_AUTH_ENTRIES);
  });

  it('zero means unlimited', () => {
    expect(maxAuthenticatorEntries({ maxAuthenticatorEntries: 0 } as any)).toBe(0);
  });
});

describe('maxAiTokensMonthly（AI 月额度：0 不表示不限，fail-closed）', () => {
  it('返回配置值', () => {
    expect(maxAiTokensMonthly({ maxAiTokensMonthly: 100_000 } as any)).toBe(100_000);
  });

  it('无缓存 / 字段缺失 / 0 / 负值 → 0（拒绝，非不限）', () => {
    expect(maxAiTokensMonthly(undefined)).toBe(0);
    expect(maxAiTokensMonthly({} as any)).toBe(0);
    expect(maxAiTokensMonthly({ maxAiTokensMonthly: 0 } as any)).toBe(0);
    expect(maxAiTokensMonthly({ maxAiTokensMonthly: -5 } as any)).toBe(0);
  });

  it('非数字/非有限值 → 0', () => {
    expect(maxAiTokensMonthly({ maxAiTokensMonthly: Number.NaN } as any)).toBe(0);
    expect(maxAiTokensMonthly({ maxAiTokensMonthly: Number.POSITIVE_INFINITY } as any)).toBe(0);
    expect(maxAiTokensMonthly({ maxAiTokensMonthly: '1000' } as any)).toBe(0);
  });

  it('小数向下取整', () => {
    expect(maxAiTokensMonthly({ maxAiTokensMonthly: 1000.9 } as any)).toBe(1000);
  });
});
