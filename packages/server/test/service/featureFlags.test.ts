import { describe, it, expect } from 'vitest';
import { resolveFeatureFlags } from '../../src/service/featureFlags.js';

describe('resolveFeatureFlags', () => {
  it('defaults payment to off (opt-in) and reserved flags to on', () => {
    const f = resolveFeatureFlags({});
    expect(f.enabled('payment')).toBe(false);
    expect(f.enabled('browser-auth')).toBe(true);
    expect(f.enabled('mail-flow')).toBe(true);
    expect(f.enabled('sync-handoff')).toBe(true);
  });

  it('enables payment only via explicit true/1/on (case-insensitive)', () => {
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: 'true' }).enabled('payment')).toBe(true);
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: '1' }).enabled('payment')).toBe(true);
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: 'ON' }).enabled('payment')).toBe(true);
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: 'yes' }).enabled('payment')).toBe(false);
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: 'false' }).enabled('payment')).toBe(false);
    expect(resolveFeatureFlags({ FEATURE_PAYMENT: '0' }).enabled('payment')).toBe(false);
  });

  it('reserved flags stay default-on and turn off via false/0/off', () => {
    expect(resolveFeatureFlags({ FEATURE_BROWSER_AUTH: 'false' }).enabled('browser-auth')).toBe(false);
    expect(resolveFeatureFlags({ FEATURE_MAIL_FLOW: '0' }).enabled('mail-flow')).toBe(false);
    expect(resolveFeatureFlags({ FEATURE_SYNC_HANDOFF: 'OFF' }).enabled('sync-handoff')).toBe(false);
    expect(resolveFeatureFlags({ FEATURE_BROWSER_AUTH: 'yes' }).enabled('browser-auth')).toBe(true);
  });

  it('resolves flags independently', () => {
    const f = resolveFeatureFlags({ FEATURE_PAYMENT: 'true', FEATURE_MAIL_FLOW: 'false' });
    expect(f.enabled('payment')).toBe(true);
    expect(f.enabled('mail-flow')).toBe(false);
    expect(f.enabled('sync-handoff')).toBe(true);
    expect(f.enabled('browser-auth')).toBe(true);
  });
});