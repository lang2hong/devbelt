import { describe, expect, it } from 'vitest';
import { resolvePriceCents } from '../../src/service/pricing.js';
import { UnknownPlanError } from '../../src/domain/errors.js';

describe('pricing', () => {
  it('resolves the pro placeholder price in cents (integer, no float)', async () => {
    expect(Number.isInteger(resolvePriceCents('pro'))).toBe(true);
    expect(resolvePriceCents('pro')).toBe(9900);
  });

  it('rejects free plans (no order needed) with UNKNOWN_PLAN', async () => {
    await expect(() => resolvePriceCents('free')).toThrow(UnknownPlanError);
  });

  it('rejects unknown plans with UNKNOWN_PLAN', async () => {
    await expect(() => resolvePriceCents('nope')).toThrow(UnknownPlanError);
  });
});