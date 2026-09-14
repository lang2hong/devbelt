// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/invoices', () => ({
  listInvoices: vi.fn(),
  requestInvoice: vi.fn(),
}));

vi.mock('../api/orders', () => ({
  listOrders: vi.fn(),
}));

vi.mock('../api/consoleAuth', () => ({
  setAccessToken: vi.fn(),
  ensureCsrf: vi.fn(async () => 'csrf'),
}));

import { listInvoices, requestInvoice } from '../api/invoices';
import { listOrders } from '../api/orders';
import { setAccessToken } from '../api/consoleAuth';

beforeEach(() => {
  vi.mocked(listInvoices).mockReset();
  vi.mocked(requestInvoice).mockReset();
  vi.mocked(listOrders).mockReset();
  vi.mocked(setAccessToken).mockReset();
});

function seed() {
  vi.mocked(listInvoices).mockResolvedValue({
    kind: 'ok',
    value: {
      items: [{ invoiceId: '1', title: 'Acme', taxNo: null, email: 'billing@a.com', amountCents: 9900, status: 'requested', reason: null, createTime: '2026-01-01T00:00:00.000Z' }],
      nextCursor: null,
    },
  });
  vi.mocked(listOrders).mockResolvedValue({
    kind: 'ok',
    value: {
      items: [{ orderNo: 'o1', planCode: 'pro', amountCents: 9900, channel: 'wechat', status: 'fulfilled', paidTime: null, expiresTime: '2026-01-01T00:00:00.000Z', createTime: '2026-01-01T00:00:00.000Z' }],
      nextCursor: null,
    },
  });
}

describe('InvoicesView', () => {
  it('renders existing invoices and fulfilled-order options', async () => {
    seed();
    const { default: InvoicesView } = await import('./InvoicesView.vue');
    const wrapper = mount(InvoicesView);
    await flushPromises();

    expect(wrapper.text()).toContain('Acme');
    expect(wrapper.text()).toContain('¥99.00');
    expect(wrapper.text()).toContain('已申请');
    // 已生效订单进入下拉（不含 orderNo 展示，但选项文案含 Pro 与金额）。
    expect(wrapper.text()).toContain('Pro');
  });
});