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
  listUsers: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { listAdminAiSkus, listAdminOrders, createAdminAiTopupOrder, getAdminAiQuota, refundAdminAiTopupOrder, listUsers, type AdminOrder } from '../api/admin';
import AdminAiTopupView from './AdminAiTopupView.vue';

const SKU = {
  code: 'topup_500k', label: { en: '500K', zh: '50万' }, tokens: 500_000, priceCents: 900, validDays: 365, status: 'active' as const, sortOrder: 0,
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(listAdminAiSkus).mockReset();
  vi.mocked(listAdminAiSkus).mockResolvedValue({ kind: 'ok', value: { items: [SKU] } });
  vi.mocked(listAdminOrders).mockReset();
  vi.mocked(listAdminOrders).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
  vi.mocked(createAdminAiTopupOrder).mockReset();
  vi.mocked(getAdminAiQuota).mockReset();
  vi.mocked(refundAdminAiTopupOrder).mockReset();
  vi.mocked(listUsers).mockReset();
  vi.mocked(listUsers).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
});

describe('AdminAiTopupView', () => {
  it('渲染档位页签与页签切换（订单在第二页签）', async () => {
    const wrapper = await mountView();

    expect(listAdminAiSkus).toHaveBeenCalledTimes(1);
    expect(listAdminOrders).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'topup' }));
    expect(wrapper.text()).toContain('topup_500k');
    expect(wrapper.text()).toContain('手工建单');
    expect(wrapper.text()).not.toContain('订单号'); // 订单表在另一页签，未渲染
    const tabBtn = Array.from(document.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === '充值订单');
    (tabBtn as HTMLElement).click();
    await flushPromises();
    expect(wrapper.text()).toContain('充值订单');
    expect(wrapper.text()).toContain('请到 用户列表');
    wrapper.unmount();
  });

  it('充值订单：展示邮箱/支付时间，详情含渠道单号', async () => {
    const order: AdminOrder = {
      orderNo: 'tp-1', userId: '9', userEmail: 'u9@b.com', userDisplayName: null,
      purpose: 'topup', planCode: null, skuCode: 'topup_500k', amountCents: 900,
      channel: 'wechat', status: 'paid', channelTradeNo: 'wx-1',
      paidTime: '2026-10-20T08:00:00Z', expiresTime: '2026-10-20T09:00:00Z',
      createTime: '2026-10-20T07:50:00Z', updateTime: '2026-10-20T08:00:00Z',
    };
    vi.mocked(listAdminOrders).mockResolvedValue({ kind: 'ok', value: { items: [order], nextCursor: null } });
    const wrapper = await mountView();
    const tabBtn = Array.from(document.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === '充值订单');
    (tabBtn as HTMLElement).click();
    await flushPromises();

    expect(wrapper.text()).toContain('u9@b.com');
    expect(wrapper.text()).toContain('2026-10-20');
    await wrapper.findAll('button').find((b) => b.text().trim() === '详情')!.trigger('click');
    await flushPromises();
    const text = document.body.textContent ?? '';
    expect(text).toContain('wx-1');
    expect(text).toContain('微信');
    expect(text).toContain('¥9.00');
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('手工建单：金额确认一致 → 提交并成功提示', async () => {
    vi.mocked(createAdminAiTopupOrder).mockResolvedValue({
      kind: 'ok',
      value: { order: { orderNo: 'tp-1', userId: 7, skuCode: 'topup_500k', tokens: 500_000, amountCents: 900, status: 'fulfilled', grantInserted: true } },
    });
    const wrapper = await mountView();

    docButton('手工建单')!.click();
    await flushPromises();
    expect(document.querySelector('input[placeholder="用户邮箱或用户ID"]')).not.toBeNull();

    docInput('用户邮箱或用户ID').value = '7';
    docInput('用户邮箱或用户ID').dispatchEvent(new Event('input'));
    docButton('查找')!.click();
    await flushPromises();
    expect(document.querySelector('.resolved')?.textContent).toContain('7');
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
    docInput('用户邮箱或用户ID').value = '7';
    docInput('用户邮箱或用户ID').dispatchEvent(new Event('input'));
    docButton('查找')!.click();
    await flushPromises();
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

  it('手工建单：邮箱查找解析用户（回显邮箱+ID，提交用解析出的 userId）', async () => {
    vi.mocked(listUsers).mockResolvedValue({
      kind: 'ok',
      value: { items: [{ userId: '7', email: 'buyer@b.com' } as never], nextCursor: null },
    });
    vi.mocked(createAdminAiTopupOrder).mockResolvedValue({
      kind: 'ok',
      value: { order: { orderNo: 'tp-e1', userId: 7, skuCode: 'topup_500k', tokens: 500_000, amountCents: 900, status: 'fulfilled', grantInserted: true } },
    });
    const wrapper = await mountView();

    docButton('手工建单')!.click();
    await flushPromises();
    docInput('用户邮箱或用户ID').value = 'buyer@b.com';
    docInput('用户邮箱或用户ID').dispatchEvent(new Event('input'));
    docButton('查找')!.click();
    await flushPromises();

    expect(listUsers).toHaveBeenCalledWith({ emailExact: 'buyer@b.com' });
    const resolved = document.querySelector('.resolved');
    expect(resolved?.textContent).toContain('buyer@b.com');
    expect(resolved?.textContent).toContain('7');
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
    wrapper.unmount();
  });

  it('手工建单：邮箱查无此人 → 就地提示且确认按钮禁用', async () => {
    vi.mocked(listUsers).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
    const wrapper = await mountView();

    docButton('手工建单')!.click();
    await flushPromises();
    docInput('用户邮箱或用户ID').value = 'ghost@b.com';
    docInput('用户邮箱或用户ID').dispatchEvent(new Event('input'));
    docButton('查找')!.click();
    await flushPromises();

    expect(wrapper.text()).toContain('未找到该邮箱对应的用户');
    expect(docButton('确认建单')!.disabled).toBe(true);
    expect(createAdminAiTopupOrder).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('手工建单：数字 ID 直填不调用户接口（查找即解析）', async () => {
    const wrapper = await mountView();
    docButton('手工建单')!.click();
    await flushPromises();

    docInput('用户邮箱或用户ID').value = '42';
    docInput('用户邮箱或用户ID').dispatchEvent(new Event('input'));
    docButton('查找')!.click();
    await flushPromises();

    expect(listUsers).not.toHaveBeenCalled();
    expect(document.querySelector('.resolved')?.textContent).toContain('42');
    wrapper.unmount();
  });

  it('充值订单：fulfilled 行有退款按钮，点击走充值退款 API', async () => {
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
    const tabBtn = Array.from(document.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === '充值订单');
    (tabBtn as HTMLElement).click();
    await flushPromises();

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