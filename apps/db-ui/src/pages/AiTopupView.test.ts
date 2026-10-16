// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/ai', () => ({
  listAiSkus: vi.fn(),
  getAiUsage: vi.fn(),
  createAiTopupOrder: vi.fn(),
}));

vi.mock('../api/orders', () => ({
  createOrder: vi.fn(),
  getOrder: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') },
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { listAiSkus, createAiTopupOrder } from '../api/ai';
import { getOrder } from '../api/orders';
import AiTopupView from './AiTopupView.vue';

const SKU = {
  code: 'topup_500k', label: { en: '500K', zh: '50万 tokens' }, tokens: 500_000, priceCents: 900, validDays: 365, status: 'active' as const, sortOrder: 0,
};

beforeEach(() => {
  vi.mocked(listAiSkus).mockReset();
  vi.mocked(listAiSkus).mockResolvedValue({ kind: 'ok', value: { items: [SKU] } });
  vi.mocked(createAiTopupOrder).mockReset();
  vi.mocked(getOrder).mockReset();
  sessionStorage.clear();
});

describe('AiTopupView（P9.1c）', () => {
  it('渲染档位卡片并默认选中第一档', async () => {
    const wrapper = mount(AiTopupView);
    await flushPromises();

    expect(listAiSkus).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('50万 tokens');
    expect(wrapper.text()).toContain('¥9.00');
    const card = wrapper.find('.sku-card');
    expect(card.classes()).toContain('on');
    wrapper.unmount();
  });

  it('下单：选档位 + 渠道 → createAiTopupOrder 正确载荷 + 二维码渲染', async () => {
    vi.mocked(createAiTopupOrder).mockResolvedValue({
      kind: 'ok',
      value: {
        order: { orderNo: 'tp-1', userId: 7, purpose: 'topup' as const, planCode: null, skuCode: 'topup_500k', amountCents: 900, channel: 'wechat', status: 'pending', paidTime: null, expiresTime: '2026-11-01T00:00:00.000Z', createTime: '2026-10-15T00:00:00.000Z' },
        payParams: { codeUrl: 'weixin://wxpay/mock' },
      },
    });
    const wrapper = mount(AiTopupView);
    await flushPromises();

    await wrapper.findAll('select').find((s) => s.element.value !== undefined)!.setValue('wechat');
    await wrapper.findAll('button').find((b) => (b.text() ?? '').includes('购买'))!.trigger('click');
    await flushPromises();

    expect(createAiTopupOrder).toHaveBeenCalledWith({ skuCode: 'topup_500k', channel: 'wechat', mode: 'qr' }, 'csrf');
    expect(wrapper.find('img.qr').exists()).toBe(true);
    expect(wrapper.text()).toContain('tp-1');
    expect(sessionStorage.getItem('devbelt.console.aiTopupPendingOrder')).toBe('tp-1');
    wrapper.unmount();
  });

  it('轮询到 fulfilled → 显示入账成功并清 pending', async () => {
    vi.mocked(createAiTopupOrder).mockResolvedValue({
      kind: 'ok',
      value: {
        order: { orderNo: 'tp-2', userId: 7, purpose: 'topup' as const, planCode: null, skuCode: 'topup_500k', amountCents: 900, channel: 'alipay', status: 'pending', paidTime: null, expiresTime: '2026-11-01T00:00:00.000Z', createTime: '2026-10-15T00:00:00.000Z' },
        payParams: { codeUrl: 'x' },
      },
    });
    vi.mocked(getOrder).mockResolvedValue({
      kind: 'ok',
      value: { orderNo: 'tp-2', purpose: 'topup' as const, planCode: null, skuCode: 'topup_500k', amountCents: 900, channel: 'alipay', status: 'fulfilled', paidTime: '2026-10-15T00:01:00.000Z', expiresTime: '2026-11-01T00:00:00.000Z', createTime: '2026-10-15T00:00:00.000Z' },
    });
    const wrapper = mount(AiTopupView);
    await flushPromises();

    await wrapper.findAll('button').find((b) => (b.text() ?? '').includes('购买'))!.trigger('click');
    await new Promise((r) => setTimeout(r, 3100)); // 等第一轮轮询（3s 间隔）
    await flushPromises();

    expect(wrapper.text()).toContain('充值已生效');
    expect(sessionStorage.getItem('devbelt.console.aiTopupPendingOrder')).toBeNull();
    wrapper.unmount();
  });

  it('支付未开放（503）→ 显示通道未开放提示', async () => {
    vi.mocked(createAiTopupOrder).mockResolvedValue({ kind: 'failure', code: 'FEATURE_TEMPORARILY_DISABLED' });
    const wrapper = mount(AiTopupView);
    await flushPromises();

    await wrapper.findAll('button').find((b) => (b.text() ?? '').includes('购买'))!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('支付通道暂未开放');
    wrapper.unmount();
  });
});