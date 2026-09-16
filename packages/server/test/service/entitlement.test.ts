import { describe, expect, it } from 'vitest';
import { deriveEntitlement, isSubscriptionActive, planEntitlement } from '../../src/service/entitlement.js';
import type { Plan } from '../../src/domain/entities.js';

function plan(code: string, features: Record<string, unknown>): Plan {
  return {
    id: code === 'free' ? 1 : code === 'organization_free' ? 3 : 2,
    code,
    kind: code.startsWith('organization') ? 'organization' : 'personal',
    name: code,
    priceCents: code === 'pro' ? 9900 : 0,
    billingUnit: code.startsWith('organization') ? 'seat-month' : 'month',
    sortOrder: 0,
    status: 'active',
    version: 1,
    features,
    createTime: new Date(),
    updateTime: new Date(),
  };
}

const FREE = plan('free', { maxConnectionMetas: 500, syncStorageBytes: 33554432 });
const PRO = plan('pro', { maxConnectionMetas: 5000, syncStorageBytes: 268435456 });
const ORG_FREE = plan('organization_free', { maxSharedResources: 50 });

const FUTURE = new Date(Date.now() + 3600_000);
const PAST = new Date(Date.now() - 1000);

describe('isSubscriptionActive', () => {
  it('active + null period_end never expires', () => {
    expect(isSubscriptionActive({ status: 'active', periodEndTime: null })).toBe(true);
  });
  it('active + future period_end is active', () => {
    expect(isSubscriptionActive({ status: 'active', periodEndTime: FUTURE })).toBe(true);
  });
  it('active + past period_end is expired', () => {
    expect(isSubscriptionActive({ status: 'active', periodEndTime: PAST })).toBe(false);
  });
  it('non-active status is inactive', () => {
    expect(isSubscriptionActive({ status: 'canceled', periodEndTime: null })).toBe(false);
  });
});

describe('deriveEntitlement（失效/缺失回 free）', () => {
  it('active subscription returns the plan features', () => {
    expect(deriveEntitlement({ status: 'active', periodEndTime: FUTURE }, PRO, FREE)).toEqual(PRO.features);
  });

  it('expired subscription falls back to free features (D2), never empty', () => {
    const ent = deriveEntitlement({ status: 'active', periodEndTime: PAST }, PRO, FREE);
    expect(ent).toEqual(FREE.features);
    expect(ent.maxConnectionMetas).toBe(500);
  });

  it('canceled subscription falls back to free features', () => {
    expect(deriveEntitlement({ status: 'canceled', periodEndTime: null }, PRO, FREE)).toEqual(FREE.features);
  });

  it('missing subscription falls back to free features', () => {
    expect(deriveEntitlement(undefined, undefined, FREE)).toEqual(FREE.features);
  });

  it('active subscription with missing plan falls back to free features', () => {
    expect(deriveEntitlement({ status: 'active', periodEndTime: null }, undefined, FREE)).toEqual(FREE.features);
  });

  it('organization free fallback uses organization_free features', () => {
    expect(deriveEntitlement({ status: 'canceled', periodEndTime: null }, undefined, ORG_FREE)).toEqual(ORG_FREE.features);
  });

  it('planEntitlement of an absent plan is empty (no features defined)', () => {
    expect(planEntitlement(undefined)).toEqual({});
  });
});