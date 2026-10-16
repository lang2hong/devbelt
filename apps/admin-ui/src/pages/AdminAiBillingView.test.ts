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
}));
vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import {
  getAdminAiBillingSettings,
  getAdminAiFinance,
  listAdminAiModelPricing,
  updateAdminAiModelPricing,
} from '../api/admin';
import AdminAiBillingView from './AdminAiBillingView.vue';

const SETTINGS = {
  activeModel: 'qwen-plus',
  upstreamBaseUrl: 'https://db.example.com/v1',
  upstreamApiKeyConfigured: true,
  upstreamApiKeyHint: '…1234',
  globalMultiplier: 1.1,
  env: { model: 'env-model', baseUrl: 'https://env.example.com/v1', apiKeyConfigured: true },
};
const FINANCE = {
  usageMonth: '2026-10',
  usage: { promptTokens: 2_000_000, completionTokens: 400_000, requestCount: 10 },
  billing: { promptTokens: 2_200_000, completionTokens: 1_100_000 },
  costCents: 840,
  pricingModel: 'qwen-plus',
  weight: 2.5,
  multiplier: 1.1,
  revenue: { topupCents: 9900, planCents: 5900 },
  marginCents: 14960,
};
const PRICING = [
  { model: 'qwen-plus', providerCode: 'dashscope', inputCentsPerM: 80, outputCentsPerM: 200, weightOverride: null, status: 'active' as const },
];

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(getAdminAiBillingSettings).mockReset().mockResolvedValue({ kind: 'ok', value: SETTINGS });
  vi.mocked(listAdminAiModelPricing).mockReset().mockResolvedValue({ kind: 'ok', value: { items: PRICING } });
  vi.mocked(getAdminAiFinance).mockReset().mockResolvedValue({ kind: 'ok', value: FINANCE });
});

describe('AdminAiBillingView', () => {
  it('生效配置/计价表/财务月报渲染：Key 只显提示不显明文', async () => {
    const w = mount(AdminAiBillingView, { attachTo: document.body });
    await flushPromises();
    const text = w.text();
    expect(text).toContain('qwen-plus');
    expect(text).toContain('…1234');
    expect(text).not.toContain('sk-');
    expect(text).toContain('2.20M'); // 计费 token（含 ×1.1）
    expect(text).toContain('1.10M');
    expect(text).toContain('¥99.00'); // 加油包实收
    expect(text).toContain('¥149.60'); // 毛利
  });

  it('停用计价行：固定 reason 调更新接口', async () => {
    vi.mocked(updateAdminAiModelPricing).mockResolvedValue({ kind: 'ok', value: { pricing: { ...PRICING[0], status: 'disabled' } } });
    const w = mount(AdminAiBillingView, { attachTo: document.body });
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === '停用')!.trigger('click');
    await flushPromises();
    expect(updateAdminAiModelPricing).toHaveBeenCalledWith('qwen-plus', { status: 'disabled' }, '运营停用', expect.any(String), 'csrf');
  });
});
