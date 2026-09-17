// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/plans', () => ({ listPlans: vi.fn() }));

import { listPlans } from '../api/plans';
import PlansView from './PlansView.vue';

const CATALOG = {
  personal: [
    {
      code: 'free',
      name: 'Free',
      billing: { unit: 'month' as const, priceCents: 0 },
      features: [
        { key: 'allowedDatabaseTypes', type: 'stringList' as const, value: ['mysql', 'sqlite'] },
        { key: 'syncStorageBytes', type: 'bytes' as const, value: 33554432 },
      ],
    },
    {
      code: 'pro',
      name: 'Pro',
      billing: { unit: 'month' as const, priceCents: 9900 },
      features: [{ key: 'allowedDatabaseTypes', type: 'stringList' as const, value: ['mysql', 'postgresql', 'sqlite'] }],
    },
  ],
  organization: [
    {
      code: 'organization_free',
      name: 'Organization Free',
      billing: { unit: 'seat-month' as const, priceCents: 0 },
      features: [{ key: 'includedSeats', type: 'number' as const, value: 3 }],
    },
  ],
};

beforeEach(() => {
  vi.mocked(listPlans).mockReset();
});

describe('PlansView', () => {
  it('renders personal and organization plans with formatted features', async () => {
    vi.mocked(listPlans).mockResolvedValue({ kind: 'ok', value: CATALOG });
    const wrapper = mount(PlansView, { props: { subscription: null } });
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('个人套餐');
    expect(text).toContain('组织套餐');
    expect(text).toContain('支持的数据库');
    expect(text).toContain('MySQL、SQLite');
    expect(text).toContain('32 MiB');
    expect(text).toContain('¥99 / 月');
    expect(text).toContain('待定价');
    expect(text).toContain('包含席位');
  });

  it('marks the free plan as current when there is no subscription and offers Pro upgrade', async () => {
    vi.mocked(listPlans).mockResolvedValue({ kind: 'ok', value: CATALOG });
    const wrapper = mount(PlansView, { props: { subscription: null } });
    await flushPromises();

    expect(wrapper.text()).toContain('当前套餐');
    const upgrade = wrapper.findAll('button').find((b) => b.text().includes('升级 Pro'));
    expect(upgrade).toBeTruthy();
  });

  it('marks Pro as current and hides the upgrade button when subscribed', async () => {
    vi.mocked(listPlans).mockResolvedValue({ kind: 'ok', value: CATALOG });
    const wrapper = mount(PlansView, { props: { subscription: { planCode: 'pro', status: 'active', periodEndTime: null } } });
    await flushPromises();

    expect(wrapper.text()).toContain('已在使用');
    expect(wrapper.findAll('button').find((b) => b.text().includes('升级'))).toBeFalsy();
  });
});