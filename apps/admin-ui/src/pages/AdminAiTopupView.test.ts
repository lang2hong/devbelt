// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises, VueWrapper } from '@vue/test-utils';

/** Modal 走 teleport(body)，交互元素直接从 document 取。 */
function docInput(ph: string): HTMLInputElement {
  const el = document.querySelector(`input[placeholder="${ph}"]`);
  return el as HTMLInputElement;
}
function docButton(text: string): HTMLButtonElement | undefined {
  const el = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text);
  return (el ?? undefined) as HTMLButtonElement | undefined;
}
async function mountView(): Promise<VueWrapper> {
  const w = mount(AdminAiTopupView, { attachTo: document.body });
  await flushPromises();
  return w;
}

vi.mock('../api/admin', () => ({
  listAdminAiSkus: vi.fn(),
  updateAdminAiSku: vi.fn(),
  createAdminAiTopupOrder: vi.fn(),
  fulfillAdminAiTopupOrder: vi.fn(),
  refundAdminAiTopupOrder: vi.fn(),
  getAdminAiQuota: vi.fn(),
  listAdminOrders: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { listAdminAiSkus, listAdminOrders, createAdminAiTopupOrder, getAdminAiQuota, refundAdminAiTopupOrder } from '../api/admin';
import AdminAiTopupView from './AdminAiTopupView.vue';

const SKU = {
  code: 'topup_500k', label: { en: '500K', zh: '50万' }, tokens: 500_000, priceCents: 900, validDays: 365, status: 'active' as const, sortOrder: 0,
};

beforeEach(() => {
  vi.mocked(listAdminAiSkus).mockReset();
  vi.mocked(listAdminAiSkus).mockResolvedValue({ kind: 'ok', value: { items: [SKU] } });
  vi.mocked(listAdminOrders).mockReset();
  vi.mocked(listAdminOrders).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
  vi.mocked(createAdminAiTopupOrder).mockReset();
  vi.mocked(getAdminAiQuota).mockReset();
  vi.mocked(refundAdminAiTopupOrder).mockReset();
});

describe('AdminAiTopupView', () => {
  it('渲染 SKU 目录与四段结构', async () => {
    const wrapper = await mountView();

    expect(listAdminAiSkus).toHaveBeenCalledTimes(1);
    expect(listAdminOrders).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'topup' }));
    expect(wrapper.text()).toContain('topup_500k');
    expect(wrapper.text()).toContain('档位目录');
    expect(wrapper.text()).toContain('加油包订单');
    expect(wrapper.text()).toContain('用户配额查询');
    wrapper.unmount();
  });

  it('手工建单：金额确认一致 → 提交并成功提示', async () => {
    vi.mocked(createAdminAiTopupOrder).mockResolvedValue({
      kind: 'ok',
      value: { order: { orderNo: 'tp-1', userId: 7, skuCode: 'topup_500k', tokens: 500_000, amountCents: 900, status: 'fulfilled', grantInserted: true } },
    });
    const wrapper = await mountView();

    docButton('手工建单')!.click();
    await flushPromises();
    expect(document.querySelector('input[placeholder="用户ID（正整数）"]')).not.toBeNull();

    docInput('用户ID（正整数）').value = '7';
    docInput('用户ID（正整数）').dispatchEvent(new Event('input'));
    docInput('确认金额（元，须与当前价一致）').value = '9';
    docInput('确认金额（元，须与当前价一致）').dispatchEvent(new Event('input'));
    docInput('建单原因（必填，进审计）').value = '客服补发';
    docInput('建单原因（必填，进审计）').dispatchEvent(new Event('input'));
    await flushPromises();

    docButton('确认建单')!.click();
    await flushPromises();

    expect(createAdminAiTopupOrder).toHaveBeenCalledWith(
      { userId: 7, skuCode: 'topup_500k', expectedAmountCents: 900, reason: '客服补发' },
      expect.any(String),
      'csrf',
    );
    expect(wrapper.text()).toContain('建单成功');
    wrapper.unmount();
  });

  it('手工建单：金额不一致 → 提交后显示提示（后端 422 路径）', async () => {
    vi.mocked(createAdminAiTopupOrder).mockResolvedValue({ kind: 'bad-request' });
    const wrapper = await mountView();

    docButton('手工建单')!.click();
    await flushPromises();
    docInput('用户ID（正整数）').value = '7';
    docInput('用户ID（正整数）').dispatchEvent(new Event('input'));
    docInput('确认金额（元，须与当前价一致）').value = '99'; // 与当前价 ¥9 不一致
    docInput('确认金额（元，须与当前价一致）').dispatchEvent(new Event('input'));
    docInput('建单原因（必填，进审计）').value = '误填';
    docInput('建单原因（必填，进审计）').dispatchEvent(new Event('input'));
    await flushPromises();

    docButton('确认建单')!.click();
    await flushPromises();

    expect(wrapper.text()).toContain('金额与当前价不一致');
    wrapper.unmount();
  });

  it('配额查询：渲染双段快照与 grants 明细', async () => {
    vi.mocked(getAdminAiQuota).mockResolvedValue({
      kind: 'ok',
      value: {
        snapshot: { used: 1000, reserved: 0, monthlyRemaining: 99_000, topupRemaining: 500_000, remaining: 599_000, resetAt: '2026-11-01T00:00:00.000Z' },
        grants: [{ grantId: 3, orderId: 11, skuCode: 'topup_500k', status: 'active', tokensTotal: 500_000, tokensUsed: 0, tokensReserved: 0, expiresTime: '2026-11-15T00:00:00.000Z' }],
      },
    });
    const wrapper = await mountView();

    await wrapper.find('input[placeholder="用户ID"]').setValue('7');
    await wrapper.findAll('button').find((b) => b.text().trim() === '查询')!.trigger('click');
    await flushPromises();

    expect(getAdminAiQuota).toHaveBeenCalledWith(7);
    expect(wrapper.text()).toContain('月额度剩余');
    expect(wrapper.text()).toContain('500,000');
    expect(wrapper.text()).toContain('topup_500k');
    expect(wrapper.text()).toContain('生效中');
    wrapper.unmount();
  });

  it('加油包订单：fulfilled 行有退款按钮，点击走加油包退款 API', async () => {
    vi.mocked(listAdminOrders).mockResolvedValue({
      kind: 'ok',
      value: {
        items: [{
          orderNo: 'tp-9', userId: '7', userEmail: null, userDisplayName: null, purpose: 'topup' as const, planCode: null, skuCode: 'topup_500k',
          amountCents: 900, channel: 'manual', status: 'fulfilled', channelTradeNo: null, paidTime: null,
          expiresTime: '2026-11-01T00:00:00.000Z', createTime: '2026-10-15T00:00:00.000Z', updateTime: '2026-10-15T00:00:00.000Z',
        }],
        nextCursor: null,
      },
    });
    vi.mocked(refundAdminAiTopupOrder).mockResolvedValue({
      kind: 'ok',
      value: { order: { orderNo: 'tp-9', userId: 7, skuCode: 'topup_500k', tokens: 500_000, amountCents: 900, status: 'refunded', grantInserted: false } },
    });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('手工');
    await wrapper.findAll('button').find((b) => b.text().trim() === '退款')!.trigger('click');
    await flushPromises();
    expect(docInput('操作原因（必填，进审计）')).not.toBeNull();
    docInput('操作原因（必填，进审计）').value = '误发撤销';
    docInput('操作原因（必填，进审计）').dispatchEvent(new Event('input'));
    await flushPromises();

    docButton('确认退款')!.click();
    await flushPromises();

    expect(refundAdminAiTopupOrder).toHaveBeenCalledWith('tp-9', '误发撤销', expect.any(String), 'csrf');
    expect(wrapper.text()).toContain('已退款（额度已撤销）');
    wrapper.unmount();
  });
});