import { describe, expect, it } from 'vitest';
import { AiQuotaService, monthKey, resetAtIso } from '../../src/modules/ai/service/aiQuotaService.js';
import { AiQuotaExceededError } from '../../src/modules/ai/domain/errors.js';
import { MemoryAiUsageRepo } from '../helpers/fakeAiUsageRepo.js';
import {
  FakePlanRepo,
  FakePersonalSubscriptionRepo,
  makeFreePlan,
  makeProPlan,
} from '../helpers/fakeRepos.js';
import type { Plan } from '../../src/domain/entities.js';

const MONTH = '2026-10';

function build(now: Date = new Date('2026-10-15T00:00:00Z')): {
  quota: AiQuotaService;
  repo: MemoryAiUsageRepo;
  plans: FakePlanRepo;
  subs: FakePersonalSubscriptionRepo;
} {
  const repo = new MemoryAiUsageRepo();
  const plans = new FakePlanRepo([makeFreePlan(), makeProPlan()]);
  const subs = new FakePersonalSubscriptionRepo();
  const quota = new AiQuotaService(repo, subs, plans, repo.runner(), () => now);
  return { quota, repo, plans, subs };
}

function setLimit(plans: FakePlanRepo, code: string, limit: number): void {
  const plan = plans.plans.find((p: Plan) => p.code === code)!;
  plan.features = { ...plan.features, maxAiTokensMonthly: limit };
}

describe('AiQuotaService.reserve', () => {
  it('按 remaining 收敛预占（prompt 优先，completion 吃剩余）', async () => {
    const { quota, plans } = build();
    setLimit(plans, 'free', 1000);

    const reservation = await quota.reserve(1, { estimatedPromptTokens: 800, maxCompletionTokens: 4096 });
    expect(reservation).toMatchObject({
      reservedPromptTokens: 800,
      reservedCompletionTokens: 200,
      usageMonth: MONTH,
      limit: 1000,
    });
    expect(reservation.resetAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('剩余不足（含在途预占）→ AiQuotaExceededError(409) 且带 limit/used/reserved/resetAt', async () => {
    const { quota, plans, repo } = build();
    setLimit(plans, 'free', 1000);
    repo.seed(1, MONTH, { promptTokens: 900, reservedPromptTokens: 100 });

    const err = await quota
      .reserve(1, { estimatedPromptTokens: 500, maxCompletionTokens: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiQuotaExceededError);
    expect((err as AiQuotaExceededError).quota).toEqual({
      limit: 1000,
      used: 900,
      reserved: 100,
      resetAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('特性缺失/0 → fail-closed 拒绝（不表示"不限"）', async () => {
    const { quota } = build();
    const err = await quota
      .reserve(1, { estimatedPromptTokens: 10, maxCompletionTokens: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiQuotaExceededError);
    expect((err as AiQuotaExceededError).quota.limit).toBe(0);
  });

  it('并发预占被串行化：不会超发，超出的请求 409', async () => {
    const { quota, plans, repo } = build();
    setLimit(plans, 'free', 1000);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        quota.reserve(1, { estimatedPromptTokens: 100, maxCompletionTokens: 100 }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(5);
    expect(rejected).toBe(15);

    const row = repo.get(1, MONTH)!;
    expect(row.reservedPromptTokens + row.reservedCompletionTokens).toBe(1000);
    expect(row.promptTokens + row.completionTokens).toBe(0);
  });

  it('有效订阅走 pro 额度；失效订阅回落 free', async () => {
    const { quota, plans, subs } = build();
    setLimit(plans, 'free', 1000);
    setLimit(plans, 'pro', 5000);
    const pro = plans.plans.find((p: Plan) => p.code === 'pro')!;

    await subs.create({ userId: 2, planId: pro.id, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    await expect(quota.resolveMonthlyLimit(2)).resolves.toBe(5000);

    const sub = await subs.findByUserId(2);
    sub!.periodEndTime = new Date('2020-01-01T00:00:00Z');
    await expect(quota.resolveMonthlyLimit(2)).resolves.toBe(1000);
  });
});

describe('AiQuotaService.settle / getUsage', () => {
  it('finish usage 权威：释放预占并记实际用量', async () => {
    const { quota, plans, repo } = build();
    setLimit(plans, 'free', 10_000);
    const reservation = await quota.reserve(1, { estimatedPromptTokens: 500, maxCompletionTokens: 4000 });
    await quota.settle(reservation, { promptTokens: 420, completionTokens: 130 });

    const row = repo.get(1, MONTH)!;
    expect(row).toMatchObject({
      promptTokens: 420,
      completionTokens: 130,
      reservedPromptTokens: 0,
      reservedCompletionTokens: 0,
      requestCount: 1,
    });
  });

  it('上游未产生 token（预流失败）→ 0 入账、全额返还预留', async () => {
    const { quota, plans, repo } = build();
    setLimit(plans, 'free', 10_000);
    const reservation = await quota.reserve(1, { estimatedPromptTokens: 500, maxCompletionTokens: 4000 });
    await quota.settle(reservation, { promptTokens: 0, completionTokens: 0 });

    const row = repo.get(1, MONTH)!;
    expect(row.promptTokens + row.completionTokens).toBe(0);
    expect(row.reservedPromptTokens + row.reservedCompletionTokens).toBe(0);
    expect(row.requestCount).toBe(1);
  });

  it('getUsage：无行全 0；有行按 limit - used - reserved 计算剩余', async () => {
    const { quota, plans, repo } = build();
    setLimit(plans, 'free', 100_000);
    await expect(quota.getUsage(1)).resolves.toMatchObject({
      usageMonth: MONTH,
      limit: 100_000,
      used: 0,
      reserved: 0,
      remaining: 100_000,
      requestCount: 0,
    });

    repo.seed(1, MONTH, { promptTokens: 30_000, completionTokens: 5_000 });
    const snapshot = await quota.getUsage(1);
    expect(snapshot).toMatchObject({ used: 35_000, remaining: 65_000, resetAt: '2026-11-01T00:00:00.000Z' });
  });
});

describe('月份工具', () => {
  it('monthKey 按 UTC 取 YYYY-MM', () => {
    expect(monthKey(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(monthKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
  });

  it('resetAtIso 为下月 1 日 00:00 UTC（跨年正确）', () => {
    expect(resetAtIso('2026-10')).toBe('2026-11-01T00:00:00.000Z');
    expect(resetAtIso('2026-12')).toBe('2027-01-01T00:00:00.000Z');
  });
});