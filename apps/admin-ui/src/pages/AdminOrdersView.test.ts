// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/admin', () => ({
  listAdminOrders: vi.fn(),
  refundAdminOrder: vi.fn(),
}));

vi.mock('@devkit/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { listAdminOrders, refundAdminOrder } from '../api/admin';
import AdminOrdersView from './AdminOrdersView.vue';

beforeEach(() => {
  vi.mocked(listAdminOrders).mockReset();
  vi.mocked(listAdminOrders).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
  vi.mocked(refundAdminOrder).mockReset();
});

describe('AdminOrdersView', () => {
  it('renders paid orders with a refund action', async () => {
    const order = {
      orderNo: 'o1', userId: '9', planCode: 'pro', userEmail: 'u9@b.com', userDisplayName: 'User Nine', amountCents: 9900, channel: 'wechat',
      status: 'paid', channelTradeNo: null, paidTime: '2026-01-01T00:00:00.000Z',
      expiresTime: '2026-01-01T00:00:00.000Z', createTime: '2026-01-01T00:00:00.000Z', updateTime: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listAdminOrders).mockResolvedValue({ kind: 'ok', value: { items: [order], nextCursor: null } });

    const wrapper = mount(AdminOrdersView);
    await flushPromises();

    expect(wrapper.text()).toContain('o1');
    expect(wrapper.findAll('button').some((b) => b.text().trim() === '退款')).toBe(true);
    wrapper.unmount();
  });

  it('non-positive user ID filter does not request and shows a hint', async () => {
    const wrapper = mount(AdminOrdersView);
    await flushPromises();
    expect(listAdminOrders).toHaveBeenCalledTimes(1);

    await wrapper.find('input[placeholder="用户ID"]').setValue('abc');
    await wrapper.findAll('button').find((b) => b.text().trim() === '查询')!.trigger('click');
    await flushPromises();

    expect(listAdminOrders).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('用户 ID 必须为正整数');
    wrapper.unmount();
  });

  it('refunding without a reason does not submit and shows the error in the modal', async () => {
    const order = {
      orderNo: 'o1', userId: '9', planCode: 'pro', userEmail: 'u9@b.com', userDisplayName: 'User Nine', amountCents: 9900, channel: 'wechat',
      status: 'paid', channelTradeNo: null, paidTime: '2026-01-01T00:00:00.000Z',
      expiresTime: '2026-01-01T00:00:00.000Z', createTime: '2026-01-01T00:00:00.000Z', updateTime: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listAdminOrders).mockResolvedValue({ kind: 'ok', value: { items: [order], nextCursor: null } });

    const wrapper = mount(AdminOrdersView, { attachTo: document.body });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '退款')!.trigger('click');
    await flushPromises();

    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认退款')!;
    confirmBtn.click();
    await flushPromises();

    expect(refundAdminOrder).not.toHaveBeenCalled();
    expect(document.querySelector('.modal')!.textContent).toContain('请填写退款原因');
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});