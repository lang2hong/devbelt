// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/admin', () => ({
  getAdminAiBillingSettings: vi.fn(),
  updateAdminAiBillingSettings: vi.fn(),
  listAdminAiModelPricing: vi.fn(),
  createAdminAiModelPricing: vi.fn(),
  updateAdminAiModelPricing: vi.fn(),
  getAdminAiFinance: vi.fn(),
  getAdminAiFinanceSummary: vi.fn(),
  listAdminAiProviders: vi.fn(),
  listAdminAiSkus: vi.fn(),
}));
vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import {
  getAdminAiBillingSettings,
  getAdminAiFinanceSummary,
  listAdminAiModelPricing,
  listAdminAiProviders,
  listAdminAiSkus,
  updateAdminAiModelPricing,
} from '../api/admin';
import AdminAiBillingView from './AdminAiBillingView.vue';

const SETTINGS = {
  activeModel: 'qwen-plus',
  upstreamBaseUrl: 'https://db.example.com/v1',
  upstreamApiKeyConfigured: true,
  upstreamApiKeyHint: '…1234',
  globalMultiplier: 1.1,
  typicalOutputRatio: 0.2,
  env: { model: 'env-model', baseUrl: 'https://env.example.com/v1', apiKeyConfigured: true },
};
const SUMMARY = {
  from: '2026-10',
  to: '2026-10',
  total: {
    requestCount: 10,
    rawPromptTokens: 2_000_000,
    rawCompletionTokens: 400_000,
    billingPromptTokens: 2_200_000,
    billingCompletionTokens: 1_100_000,
    costCents: 840,
    topupCents: 9900,
    planCents: 5900,
    marginCents: 14960,
  },
  months: [{
    usageMonth: '2026-10',
    requestCount: 10,
    rawPromptTokens: 2_000_000,
    rawCompletionTokens: 400_000,
    billingPromptTokens: 2_200_000,
    billingCompletionTokens: 1_100_000,
    costCents: 840,
    topupCents: 9900,
    planCents: 5900,
    marginCents: 14960,
  }],
  models: [{
    model: 'qwen-plus',
    requestCount: 10,
    rawPromptTokens: 2_000_000,
    rawCompletionTokens: 400_000,
    billingPromptTokens: 2_200_000,
    billingCompletionTokens: 1_100_000,
    costCents: 840,
  }],
};
const PRICING = [
  { model: 'qwen-plus', providerCode: 'dashscope', inputCentsPerM: 80, outputCentsPerM: 200, weightOverride: null, multiplierOverride: null, status: 'active' as const },
];
const SKU = {
  code: 'topup_500k', label: { en: '500K', zh: '50万' }, tokens: 500_000, priceCents: 900, validDays: 365, status: 'active' as const, sortOrder: 0,
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(getAdminAiBillingSettings).mockReset().mockResolvedValue({ kind: 'ok', value: SETTINGS });
  vi.mocked(listAdminAiModelPricing).mockReset().mockResolvedValue({ kind: 'ok', value: { items: PRICING } });
  vi.mocked(getAdminAiFinanceSummary).mockReset().mockResolvedValue({ kind: 'ok', value: SUMMARY });
  vi.mocked(listAdminAiProviders).mockReset().mockResolvedValue({ kind: 'ok', value: { items: [{ code: 'dashscope', name: { en: 'DashScope', zh: '百炼' }, baseUrl: 'https://x/v1', models: [], status: 'active', sortOrder: 0 }] } });
  vi.mocked(listAdminAiSkus).mockReset().mockResolvedValue({ kind: 'ok', value: { items: [SKU] } });
});

async function switchTab(label: string): Promise<void> {
  const btn = Array.from(document.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === label);
  (btn as HTMLElement).click();
  await flushPromises();
}

describe('AdminAiBillingView', () => {
  it('经营概览默认展示：区间指标卡 + 逐月/模型表（积分口径），Key 只显提示不显明文', async () => {
    const w = mount(AdminAiBillingView, { attachTo: document.body });
    await flushPromises();
    const text = w.text();
    expect(text).toContain('请求次数');
    expect(text).toContain('3,300'); // 消耗积分（(2.2M+1.1M)/1000）
    expect(text).toContain('¥158.00'); // 实收合计（9900+5900 分）
    expect(text).toContain('充值收入');
    expect(text).toContain('套餐收入');
    expect(text).toContain('¥149.60'); // 毛利
    expect(text).toContain('毛利率');
    expect(text).toContain('逐月明细');
    expect(text).toContain('模型毛利');
    expect(text).toContain('qwen-plus');

    await switchTab('接入设置');
    const text2 = w.text();
    expect(text2).toContain('qwen-plus');
    expect(text2).toContain('…1234');
    expect(text2).not.toContain('sk-');
    expect(text2).toContain('全局计费倍率');
    expect(text2).toContain('成本测算输出占比');
  });

  it('模型价格页签：每积分成本/测算毛利率列 + 停用走固定 reason 更新接口', async () => {
    vi.mocked(updateAdminAiModelPricing).mockResolvedValue({ kind: 'ok', value: { pricing: { ...PRICING[0], status: 'disabled' } } });
    const w = mount(AdminAiBillingView, { attachTo: document.body });
    await flushPromises();
    await switchTab('模型价格');
    const text = w.text();
    expect(text).toContain('计费倍率');
    expect(text).toContain('用全局');
    expect(text).toContain('每积分成本');
    expect(text).toContain('测算毛利率');
    // 每积分成本：k=2.5 推导=输出/输入；r=0.2 → 1000×[(0.8×80+0.2×200)/1M]/[(0.8+0.2×2.5)] = 0.096 分。
    expect(text).toContain('¥0.00');
    await w.findAll('button').find((b) => b.text() === '停用')!.trigger('click');
    await flushPromises();
    expect(updateAdminAiModelPricing).toHaveBeenCalledWith('qwen-plus', { status: 'disabled' }, '运营停用', expect.any(String), 'csrf');
  });
});
