// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AdminInvoice } from '../api/admin';

vi.mock('../api/admin', () => ({
  listAdminInvoices: vi.fn(),
  setInvoiceStatus: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { listAdminInvoices, setInvoiceStatus } from '../api/admin';
import AdminInvoicesView from './AdminInvoicesView.vue';

beforeEach(() => {
  vi.mocked(listAdminInvoices).mockReset();
  vi.mocked(listAdminInvoices).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
  vi.mocked(setInvoiceStatus).mockReset();
});

describe('AdminInvoicesView', () => {
  it('renders requested invoices with a handle action', async () => {
    const inv: AdminInvoice = {
      invoiceId: '1', userId: '9', title: 'Acme', taxNo: null, email: 'b@a.com',
      amountCents: 9900, status: 'requested', reason: null, createTime: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listAdminInvoices).mockResolvedValue({ kind: 'ok', value: { items: [inv], nextCursor: null } });

    const wrapper = mount(AdminInvoicesView);
    await flushPromises();

    expect(wrapper.text()).toContain('Acme');
    expect(wrapper.text()).toContain('处理中');
    expect(wrapper.findAll('button').some((b) => b.text().trim() === '处理')).toBe(true);
    wrapper.unmount();
  });

  it('rejecting without a reason does not submit', async () => {
    const inv: AdminInvoice = {
      invoiceId: '1', userId: '9', title: 'Acme', taxNo: null, email: 'b@a.com',
      amountCents: 9900, status: 'requested', reason: null, createTime: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listAdminInvoices).mockResolvedValue({ kind: 'ok', value: { items: [inv], nextCursor: null } });

    const wrapper = mount(AdminInvoicesView, { attachTo: document.body });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '处理')!.trigger('click');
    await flushPromises();

    const modalSelect = document.querySelector('.modal select') as HTMLSelectElement;
    modalSelect.value = 'rejected';
    modalSelect.dispatchEvent(new Event('change'));
    await flushPromises();

    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')!;
    confirmBtn.click();
    await flushPromises();

    expect(setInvoiceStatus).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请填写原因');
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('non-positive user ID filter does not request and shows a hint', async () => {
    const wrapper = mount(AdminInvoicesView);
    await flushPromises();
    expect(listAdminInvoices).toHaveBeenCalledTimes(1);

    await wrapper.find('input[placeholder="用户ID"]').setValue('abc');
    await wrapper.findAll('button').find((b) => b.text().trim() === '查询')!.trigger('click');
    await flushPromises();

    expect(listAdminInvoices).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('用户 ID 必须为正整数');
    wrapper.unmount();
  });

  it('slow superseded search does not overwrite the newer result', async () => {
    const makeInv = (id: string, title: string): AdminInvoice => ({
      invoiceId: id, userId: '9', title, taxNo: null, email: 'b@a.com',
      amountCents: 9900, status: 'requested', reason: null, createTime: '2026-01-01T00:00:00.000Z',
    });
    let resolveOld!: (v: unknown) => void;
    vi.mocked(listAdminInvoices).mockReset();
    vi.mocked(listAdminInvoices)
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }) as never)
      .mockResolvedValueOnce({ kind: 'ok', value: { items: [makeInv('2', 'Beta')], nextCursor: null } });

    const wrapper = mount(AdminInvoicesView);
    await flushPromises(); // 挂载触发 load → 第一次调用（旧搜索）挂起

    await wrapper.find('input[placeholder="用户ID"]').setValue('20');
    await wrapper.findAll('button').find((b) => b.text().trim() === '查询')!.trigger('click');
    await flushPromises(); // 第二次 load 返回 Beta

    resolveOld({ kind: 'ok', value: { items: [makeInv('1', 'Alpha')], nextCursor: null } });
    await flushPromises(); // 旧搜索迟到返回，应被 loadSeq 丢弃

    expect(wrapper.text()).toContain('Beta');
    expect(wrapper.text()).not.toContain('Alpha');
    wrapper.unmount();
  });
});