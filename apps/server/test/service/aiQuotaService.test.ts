import { describe, expect, it } from 'vitest';
import { AiQuotaService, monthKey, resetAtIso } from '../../src/modules/ai/service/aiQuotaService.js';
import { AiQuotaExceededError } from '../../src/modules/ai/domain/errors.js';
import { MemoryAiUsageRepo } from '../helpers/fakeAiUsageRepo.js';
import { MemoryAiRequestLogRepo } from '../helpers/fakeAiBillingRepo.js';
import { MemoryAiTopupRepo } from '../helpers/fakeAiTopupRepo.js';
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
  grants: MemoryAiTopupRepo;
  plans: FakePlanRepo;
  subs: FakePersonalSubscriptionRepo;
  logRepo: MemoryAiRequestLogRepo;
} {
  const repo = new MemoryAiUsageRepo();
  const grants = new MemoryAiTopupRepo();
  const plans = new FakePlanRepo([makeFreePlan(), makeProPlan()]);
  const subs = new FakePersonalSubscriptionRepo();
  const logRepo = new MemoryAiRequestLogRepo();
  const quota = new AiQuotaService(repo, grants, subs, plans, repo.runner(), () => now, logRepo);
  return { quota, repo, grants, plans, subs, logRepo };
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
      topupRemaining: 0,
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

describe('AiQuotaService 双段（月额度 + 加油包 grants FIFO，P9.1）', () => {
  const AFTER = new Date('2026-11-01T00:00:00Z');
  const BEFORE = new Date('2026-10-20T00:00:00Z');

  it('月额度耗尽 → 加油包承接预占（分配进 grants，可越过月限）', async () => {
    const { quota, plans, repo, grants } = build();
    setLimit(plans, 'free', 1000);
    repo.seed(1, MONTH, { promptTokens: 1000 });
    const grantId = grants.seedGrant({ userId: 1, tokens: 5000, expiresTime: AFTER });

    const reservation = await quota.reserve(1, { estimatedPromptTokens: 500, maxCompletionTokens: 100 });
    expect(reservation.reservedPromptTokens).toBe(0);
    expect(reservation.reservedCompletionTokens).toBe(0);
    expect(reservation.grantAllocations).toEqual([{ grantId, tokens: 600 }]);
    expect(grants.grants.get(grantId)?.tokensReserved).toBe(600);
  });

  it('FIFO：先到期的 grant 先扣（多条时按 expires_time 升序吃满）', async () => {
    const { quota, plans, repo, grants } = build();
    setLimit(plans, 'free', 0);
    const g1 = grants.seedGrant({ userId: 1, tokens: 300, expiresTime: BEFORE });
    const g2 = grants.seedGrant({ userId: 1, tokens: 1000, expiresTime: AFTER });

    const reservation = await quota.reserve(1, { estimatedPromptTokens: 500, maxCompletionTokens: 100 });
    expect(reservation.grantAllocations).toEqual([
      { grantId: g1, tokens: 300 },
      { grantId: g2, tokens: 300 },
    ]);
  });

  it('结算：月段优先吸收，grants 最多吃满其分配（超出分配部分由月段吸收）', async () => {
    const { quota, plans, repo, grants } = build();
    setLimit(plans, 'free', 1000);
    const g1 = grants.seedGrant({ userId: 1, tokens: 1000, expiresTime: AFTER });

    const reservation = await quota.reserve(1, { estimatedPromptTokens: 1500, maxCompletionTokens: 100 });
    expect(reservation.reservedPromptTokens).toBe(1000);
    expect(reservation.reservedCompletionTokens).toBe(0);
    expect(reservation.grantAllocations).toEqual([{ grantId: g1, tokens: 600 }]);

    await quota.settle(reservation, { promptTokens: 1700, completionTokens: 0 });
    const usage = repo.get(1, MONTH)!;
    expect(usage.promptTokens).toBe(1700); // 月段吸收全部实际
    expect(usage.reservedPromptTokens).toBe(0);
    const grant = grants.grants.get(g1)!;
    expect(grant.tokensUsed).toBe(600); // 超出月段分配(1000)的 700 中，最多吃满分配 600
    expect(grant.tokensReserved).toBe(0);
  });

  it('结算 under-run：实际远低于预占 → grants 全额释放不扣', async () => {
    const { quota, plans, grants } = build();
    setLimit(plans, 'free', 100);
    const g1 = grants.seedGrant({ userId: 1, tokens: 1000, expiresTime: AFTER });

    const reservation = await quota.reserve(1, { estimatedPromptTokens: 500, maxCompletionTokens: 100 });
    expect(reservation.grantAllocations).toEqual([{ grantId: g1, tokens: 500 }]);

    await quota.settle(reservation, { promptTokens: 20, completionTokens: 10 });
    const grant = grants.grants.get(g1)!;
    expect(grant.tokensUsed).toBe(0);
    expect(grant.tokensReserved).toBe(0);
  });

  it('双段都空 → 409 且 topupRemaining=0', async () => {
    const { quota, plans, repo, grants } = build();
    setLimit(plans, 'free', 1000);
    repo.seed(1, MONTH, { promptTokens: 1000 });
    grants.seedGrant({ userId: 1, tokens: 500, expiresTime: new Date('2026-10-01T00:00:00Z') }); // 已过期

    const err = await quota
      .reserve(1, { estimatedPromptTokens: 10, maxCompletionTokens: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiQuotaExceededError);
    expect((err as AiQuotaExceededError).quota.topupRemaining).toBe(0);
  });

  it('过期 grant 不参与可用（惰性翻状态 + 快照排除）', async () => {
    const { quota, plans, grants } = build();
    setLimit(plans, 'free', 0);
    const stale = grants.seedGrant({ userId: 1, tokens: 999, expiresTime: new Date('2026-10-01T00:00:00Z') });
    grants.seedGrant({ userId: 1, tokens: 100, expiresTime: AFTER });

    const snapshot = await quota.getUsage(1);
    expect(snapshot.topupRemaining).toBe(100);
    const reservation = await quota.reserve(1, { estimatedPromptTokens: 50, maxCompletionTokens: 0 });
    expect(reservation.grantAllocations).toHaveLength(1);
    expect(grants.grants.get(stale)?.status).toBe('expired');
  });

  it('快照：remaining = 月段剩余 + 加油包余额', async () => {
    const { quota, plans, repo, grants } = build();
    setLimit(plans, 'free', 1000);
    repo.seed(1, MONTH, { promptTokens: 400 });
    grants.seedGrant({ userId: 1, tokens: 700, expiresTime: AFTER });

    const snapshot = await quota.getUsage(1);
    expect(snapshot.monthlyRemaining).toBe(600);
    expect(snapshot.topupRemaining).toBe(700);
    expect(snapshot.remaining).toBe(1300);
  });

describe('AiQuotaService · 请求流水（012）', () => {
  it('settle 带 meta：同事务写 ai_request_log，月账本累计原始与计费两套口径', async () => {
    const { quota, repo, logRepo, plans } = build();
    setLimit(plans, 'free', 100_000);
    const r = await quota.reserve(7, { estimatedPromptTokens: 500, maxCompletionTokens: 200 });
    await quota.settle(
      r,
      { promptTokens: 220, completionTokens: 55 },
      { model: 'm-a', rawPromptTokens: 200, rawCompletionTokens: 20, weight: 2.5, multiplier: 1.1, costCents: 12, status: 'completed', usageEstimated: false, latencyMs: 42 },
    );
    const row = repo.get(7, '2026-10')!;
    expect(row.promptTokens).toBe(220); // 计费（= 积分池）
    expect(row.completionTokens).toBe(55);
    expect(row.rawPromptTokens).toBe(200); // 原始
    expect(row.rawCompletionTokens).toBe(20);
    expect(logRepo.rows).toHaveLength(1);
    expect(logRepo.rows[0]).toMatchObject({
      userId: 7, model: 'm-a', rawPromptTokens: 200, billingPromptTokens: 220, billingCompletionTokens: 55, costCents: 12, status: 'completed',
    });
  });

  it('settle 不带 meta：不写流水、raw 回退为计费口径（兼容旧调用）', async () => {
    const { quota, repo, logRepo, plans } = build();
    setLimit(plans, 'free', 100_000);
    const r = await quota.reserve(7, { estimatedPromptTokens: 100, maxCompletionTokens: 50 });
    await quota.settle(r, { promptTokens: 100, completionTokens: 10 });
    expect(logRepo.rows).toHaveLength(0);
    expect(repo.get(7, '2026-10')!.rawPromptTokens).toBe(100);
  });
});
});
