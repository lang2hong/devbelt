import { describe, expect, it } from 'vitest';
import { maxAuthenticatorEntries, DEFAULT_FREE_MAX_AUTH_ENTRIES } from '../src/sync/entitlementGate.js';

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
