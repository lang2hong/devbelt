import { describe, expect, it } from 'vitest';
import {
  AiBillingService,
  billingTokens,
  costCents,
  deriveWeight,
} from '../../src/modules/ai/service/aiBillingService.js';
import type { AiModelPricing } from '../../src/modules/ai/repository/aiBillingRepo.js';
import { MemoryAiBillingRepo } from '../helpers/fakeAiBillingRepo.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ENV = { configured: true, baseUrl: 'https://env.example.com/v1', apiKey: 'env-key', model: 'env-model' };
const tx = {} as Queryable;

function pricing(over: Partial<AiModelPricing> = {}): AiModelPricing {
  return {
    model: 'm1', providerCode: null, inputCentsPerM: 80, outputCentsPerM: 200,
    weightOverride: null, status: 'active', ...over,
  };
}

describe('统一 token 计费纯函数', () => {
  it('deriveWeight：显式覆盖优先；否则由单价推导（input=0 回退 1）；无计价回退 1', () => {
    expect(deriveWeight(null)).toBe(1);
    expect(deriveWeight(pricing({ inputCentsPerM: 80, outputCentsPerM: 200 }))).toBeCloseTo(2.5);
    expect(deriveWeight(pricing({ weightOverride: 3 }))).toBe(3);
    expect(deriveWeight(pricing({ inputCentsPerM: 0 }))).toBe(1);
  });
  it('billingTokens：输入×系数 + 输出×k×系数；取整且非负', () => {
    expect(billingTokens(100, 40, 2.5, 1)).toEqual({ prompt: 100, completion: 100 });
    expect(billingTokens(100, 40, 2.5, 1.1)).toEqual({ prompt: 110, completion: 110 });
    expect(billingTokens(0, 0, 2, 1)).toEqual({ prompt: 0, completion: 0 });
    expect(billingTokens(1, 1, 1.005, 1)).toEqual({ prompt: 1, completion: 1 });
  });
  it('costCents：分/1M 单价折算；无计价返回 null', () => {
    expect(costCents(1_000_000, 1_000_000, pricing())).toBe(280);
    expect(costCents(500_000, 0, pricing())).toBe(40);
    expect(costCents(1, 1, null)).toBeNull();
  });
});

describe('AiBillingService · 生效配置（设置优先、env 回退、缓存失效）', () => {
  it('无设置/无计价：env 全回退，k=1 系数=1（兼容现状）', async () => {
    const svc = new AiBillingService(new MemoryAiBillingRepo(), ENV);
    const up = await svc.upstream();
    expect(up).toMatchObject({ configured: true, model: 'env-model', baseUrl: 'https://env.example.com/v1', apiKey: 'env-key', weight: 1, multiplier: 1, pricing: null });
  });

  it('设置覆盖 env；激活模型取计价行推导 k；写后缓存即时失效', async () => {
    const repo = new MemoryAiBillingRepo();
    const svc = new AiBillingService(repo, ENV);
    await svc.createPricingInTx(tx, { model: 'qwen-plus', inputCentsPerM: 80, outputCentsPerM: 200 });
    await svc.updateSettingsInTx(tx, { activeModel: 'qwen-plus', upstreamBaseUrl: 'https://dashscope.example.com/v1', upstreamApiKey: 'db-key', globalMultiplier: 1.2 });
    const up = await svc.upstream();
    expect(up).toMatchObject({ model: 'qwen-plus', baseUrl: 'https://dashscope.example.com/v1', apiKey: 'db-key', multiplier: 1.2 });
    expect(up.weight).toBeCloseTo(2.5);
    expect(up.pricing?.model).toBe('qwen-plus');
  });

  it('env 未配置（configured=false）：设置仍可生效（fail-closed 解锁）', async () => {
    const repo = new MemoryAiBillingRepo();
    const svc = new AiBillingService(repo, { configured: false, model: '' });
    await svc.updateSettingsInTx(tx, { activeModel: 'm', upstreamBaseUrl: 'https://x.example.com/v1' });
    expect((await svc.upstream()).configured).toBe(true);
  });

  it('设置校验：非 https 远程地址/非法模型名/系数越界拒绝；空串=清除回退 env', async () => {
    const svc = new AiBillingService(new MemoryAiBillingRepo(), ENV);
    await expect(svc.updateSettingsInTx(tx, { upstreamBaseUrl: 'http://remote.example.com/v1' })).rejects.toThrow();
    await expect(svc.updateSettingsInTx(tx, { activeModel: 'has space' })).rejects.toThrow();
    await expect(svc.updateSettingsInTx(tx, { globalMultiplier: 0 })).rejects.toThrow();
    await expect(svc.updateSettingsInTx(tx, { upstreamApiKey: 'a b' })).rejects.toThrow();
    const repo = new MemoryAiBillingRepo();
    const svc2 = new AiBillingService(repo, ENV);
    await svc2.updateSettingsInTx(tx, { upstreamBaseUrl: 'https://db.example.com/v1' });
    await svc2.updateSettingsInTx(tx, { upstreamBaseUrl: '' });
    expect((await svc2.upstream()).baseUrl).toBe('https://env.example.com/v1');
  });
});

describe('AiBillingService · 计价表 CRUD 校验', () => {
  it('新增/更新：模型名、厂商 code、分价、权重校验；重复 409（undefined）', async () => {
    const svc = new AiBillingService(new MemoryAiBillingRepo(), ENV);
    const row = await svc.createPricingInTx(tx, { model: 'm1', providerCode: 'openai', inputCentsPerM: 80, outputCentsPerM: 200, weightOverride: 2 });
    expect(row).toMatchObject({ model: 'm1', providerCode: 'openai', weightOverride: 2 });
    expect(await svc.createPricingInTx(tx, { model: 'm1' })).toBeUndefined();
    await expect(svc.createPricingInTx(tx, { model: 'bad name' })).rejects.toThrow();
    await expect(svc.createPricingInTx(tx, { model: 'm2', providerCode: 'BadCode' })).rejects.toThrow();
    await expect(svc.createPricingInTx(tx, { model: 'm2', inputCentsPerM: -1 })).rejects.toThrow();
    await expect(svc.createPricingInTx(tx, { model: 'm2', weightOverride: 0 })).rejects.toThrow();
    const updated = await svc.updatePricingInTx(tx, 'm1', { status: 'disabled', weightOverride: null });
    expect(updated).toMatchObject({ status: 'disabled', weightOverride: null });
    expect(await svc.updatePricingInTx(tx, 'nope', { status: 'disabled' })).toBeUndefined();
  });
});

describe('AiBillingService · 财务月报', () => {
  it('月度聚合：原始/计费 token、成本、实收、毛利；非法月份拒绝', async () => {
    const repo = new MemoryAiBillingRepo();
    repo.usageByMonth.set('2026-10', { usageMonth: '2026-10', promptTokens: 2_000_000, completionTokens: 400_000, requestCount: 100 });
    repo.revenueByMonth.set('2026-10', { topupCents: 9900, planCents: 5900 });
    const svc = new AiBillingService(repo, ENV);
    await svc.createPricingInTx(tx, { model: 'env-model', inputCentsPerM: 80, outputCentsPerM: 200 });
    await svc.updateSettingsInTx(tx, { activeModel: 'env-model', globalMultiplier: 1 });
    const f = await svc.finance('2026-10');
    expect(f.usage).toEqual({ promptTokens: 2_000_000, completionTokens: 400_000, requestCount: 100 });
    // k = 200/80 = 2.5 → billing completion = 400k × 2.5 = 1M
    expect(f.billing).toEqual({ promptTokens: 2_000_000, completionTokens: 1_000_000 });
    expect(f.costCents).toBe(2_000_000 / 1e6 * 80 + 400_000 / 1e6 * 200);
    expect(f.marginCents).toBe(9900 + 5900 - f.costCents!);
    expect(f.revenue).toEqual({ topupCents: 9900, planCents: 5900 });
    await expect(svc.finance('2026-13')).rejects.toThrow();
    await expect(svc.finance('bad')).rejects.toThrow();
  });
});
