import { describe, it, expect } from 'vitest';
import { resolveFeatureFlags } from '../../src/service/featureFlags.js';

describe('resolveFeatureFlags', () => {
  it('defaults all flags to enabled', () => {
    const f = resolveFeatureFlags({});
    expect(f.enabled('payment')).toBe(true);
    expect(f.enabled('browser-auth')).toBe(true);
    expect(f.enabled('mail-flow')).toBe(true);
    expect(f.enabled('sync-handoff')).toBe(true);
  });

  it('turns a flag off via false/0/off (case-insensitive)', () => {
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: 'false' }).enabled('payment')).toBe(false);
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: '0' }).enabled('payment')).toBe(false);
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: 'OFF' }).enabled('payment')).toBe(false);
  });

  it('treats any other value as enabled', () => {
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: 'true' }).enabled('payment')).toBe(true);
    expect(resolveFeatureFlags({ FEATURE_BROWSER_AUTH: 'yes' }).enabled('browser-auth')).toBe(true);
  });

  it('resolves flags independently', () => {
    const f = resolveFeatureFlags({ FEATURE_PAYMENT: 'false', FEATURE_MAIL_FLOW: 'false' });
    expect(f.enabled('payment')).toBe(false);
    expect(f.enabled('mail-flow')).toBe(false);
    expect(f.enabled('sync-handoff')).toBe(true);
    expect(f.enabled('browser-auth')).toBe(true);
  });
});