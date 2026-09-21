// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/orders', () => ({
  listOrders: vi.fn(),
  getOrder: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  setAccessToken: vi.fn(),
}));

import { listOrders, type ConsoleOrder } from '../api/orders';
import { setAccessToken } from '@devbelt/auth-client';

beforeEach(() => {
  vi.mocked(listOrders).mockReset();
  vi.mocked(setAccessToken).mockReset();
});

describe('OrdersView', () => {
  it('renders fulfilled/pending orders with status and amount', async () => {
    vi.mocked(listOrders).mockResolvedValue({
      kind: 'ok',
      value: {
        items: [
          { orderNo: 'o1', planCode: 'pro', amountCents: 9900, channel: 'wechat', status: 'fulfilled', paidTime: null, expiresTime: '2026-01-01T00:00:00.000Z', createTime: '2026-01-01T00:00:00.000Z' },
          { orderNo: 'o2', planCode: 'pro', amountCents: 9900, channel: 'alipay', status: 'pending', paidTime: null, expiresTime: '2026-01-01T00:00:00.000Z', createTime: '2026-01-01T00:00:00.000Z' },
        ],
        nextCursor: null,
      },
    });

    const { default: OrdersView } = await import('./OrdersView.vue');
    const wrapper = mount(OrdersView);
    await flushPromises();

    expect(wrapper.text()).toContain('Pro');
    expect(wrapper.text()).toContain('99.00');
    expect(wrapper.text()).toContain('已生效');
    expect(wrapper.text()).toContain('待支付');
  });

  it('redirects to login on unauthorized', async () => {
    vi.mocked(listOrders).mockResolvedValue({ kind: 'unauthorized' });
    vi.mocked(setAccessToken).mockImplementation(() => {});
    const { default: OrdersView } = await import('./OrdersView.vue');
    const wrapper = mount(OrdersView);
    await flushPromises();
    expect(setAccessToken).toHaveBeenCalledWith(null);
    expect(wrapper.text()).toContain('加载');
  });

  function order(overrides: Partial<ConsoleOrder>): ConsoleOrder {
    return {
      orderNo: 'o1', planCode: 'pro', amountCents: 9900, channel: 'alipay', status: 'pending',
      paidTime: null, expiresTime: new Date(Date.now() + 3_600_000).toISOString(),
      createTime: '2026-01-01T00:00:00.000Z', ...overrides,
    };
  }

  it('pending 且已过本地有效期显示为已过期，并提供重新下单', async () => {
    vi.mocked(listOrders).mockResolvedValue({
      kind: 'ok',
      value: { items: [order({ status: 'pending', expiresTime: new Date(Date.now() - 1000).toISOString() })], nextCursor: null },
    });
    const { default: OrdersView } = await import('./OrdersView.vue');
    const wrapper = mount(OrdersView);
    await flushPromises();
    expect(wrapper.text()).toContain('已过期');
    expect(wrapper.text()).toContain('重新下单');
  });

  it('pending 未过期不显示重新下单', async () => {
    vi.mocked(listOrders).mockResolvedValue({
      kind: 'ok',
      value: { items: [order({ status: 'pending', expiresTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() })], nextCursor: null },
    });
    const { default: OrdersView } = await import('./OrdersView.vue');
    const wrapper = mount(OrdersView);
    await flushPromises();
    expect(wrapper.text()).toContain('待支付');
    expect(wrapper.text()).not.toContain('重新下单');
  });

  it('failed 订单同样提供重新下单', async () => {
    vi.mocked(listOrders).mockResolvedValue({
      kind: 'ok',
      value: { items: [order({ status: 'failed', expiresTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() })], nextCursor: null },
    });
    const { default: OrdersView } = await import('./OrdersView.vue');
    const wrapper = mount(OrdersView);
    await flushPromises();
    expect(wrapper.text()).toContain('支付失败');
    expect(wrapper.text()).toContain('重新下单');
  });
});