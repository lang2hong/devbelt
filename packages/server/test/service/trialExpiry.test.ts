import { describe, expect, it, beforeEach } from 'vitest';
import { SubscriptionService } from '../../src/service/subscriptionService.js';
import { PlanPolicy, resolveEffectivePlans } from '../../src/policy/planPolicy.js';
import type { PlanCode } from '../../src/domain/enums.js';
import {
  FakeUserRepo, FakePlanRepo, FakeSubscriptionRepo, FakeDeviceRepo, FakeSyncRepo,
  FakeConnectionMetaRepo, FakeOrganizationRepo, FakeMembershipRepo, FakeSeatRepo,
  FakeRegistrationRepo, makePlan,
} from '../helpers/fakeRepos.js';

/**
 * 试用期到期（v2：订阅挂组织，到期只置 status=expired，不回写 users.plan_code）。
 * trialing / canceled 同 active 一起参与到期降级，expired 是终态。
 */
const DAY = 86400_000;

async function setup() {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro'), makePlan('team')]);
  const subRepo = new FakeSubscriptionRepo();
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const seatRepo = new FakeSeatRepo();
  const registrationRepo = new FakeRegistrationRepo({
    users: userRepo, orgs: orgRepo, memberships: membershipRepo, subs: subRepo, seats: seatRepo, plans: planRepo,
  });
  const planPolicy = new PlanPolicy((id) => resolveEffectivePlans(id, { membershipRepo, subRepo, planRepo }));
  const service = new SubscriptionService(
    userRepo, planRepo, subRepo, membershipRepo, orgRepo,
    new FakeDeviceRepo(), new FakeSyncRepo(), new FakeConnectionMetaRepo(), planPolicy,
  );
  const { userId } = await registrationRepo.createAccount({ email: 'a@example.com', passwordHash: 'x', role: 'user' });
  return { service, userRepo, planRepo, subRepo, membershipRepo, registrationRepo, userId };
}

/** 把某用户 personal org 的订阅切到指定套餐/状态/到期时间，返回 organizationId */
async function setOrgSub(userId: number, code: PlanCode, status: string, periodEndTime: Date | undefined, c: Awaited<ReturnType<typeof setup>>): Promise<number> {
  const m = (await c.membershipRepo.listByUser(userId)).find((x) => x.status === 'active')!;
  const plan = (await c.planRepo.findByCode(code))!;
  await c.subRepo.upsert({ organizationId: m.organizationId, planId: plan.id, status: status as any, periodEndTime, provider: 'manual' });
  return m.organizationId;
}

let c: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { c = await setup(); });

describe('ensureActive 处理 trialing', () => {
  it('试用期已过 → 置为 expired', async () => {
    const orgId = await setOrgSub(c.userId, 'pro', 'trialing', new Date(Date.now() - DAY), c);
    await c.service.ensureActive(c.userId);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('expired');
  });

  it('试用期未到 → 保持 trialing', async () => {
    const orgId = await setOrgSub(c.userId, 'pro', 'trialing', new Date(Date.now() + DAY), c);
    await c.service.ensureActive(c.userId);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('trialing');
  });

  it('边界：结束时刻恰好等于 now 也算到期', async () => {
    const now = new Date();
    const orgId = await setOrgSub(c.userId, 'pro', 'trialing', now, c);
    await c.service.ensureActive(c.userId, now);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('expired');
  });

  it('canceled 到期同样降级', async () => {
    const orgId = await setOrgSub(c.userId, 'pro', 'canceled', new Date(Date.now() - DAY), c);
    await c.service.ensureActive(c.userId);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('expired');
  });

  it('已经是 expired 的不再重复处理', async () => {
    await setOrgSub(c.userId, 'free', 'expired', new Date(Date.now() - DAY), c);
    c.subRepo.expireOneCalls = 0;
    await c.service.ensureActive(c.userId);
    expect(c.subRepo.expireOneCalls).toBe(0);
  });
});

describe('downgradeExpired 处理 trialing', () => {
  it('批量降级覆盖 trialing 与 canceled', async () => {
    const past = new Date(Date.now() - DAY);
    const future = new Date(Date.now() + DAY);
    const aId = await setOrgSub(c.userId, 'pro', 'trialing', past, c);
    const b = await c.registrationRepo.createAccount({ email: 'b@example.com', passwordHash: 'x', role: 'user' });
    const bOrg = await setOrgSub(b.userId, 'pro', 'canceled', past, c);
    const d = await c.registrationRepo.createAccount({ email: 'd@example.com', passwordHash: 'x', role: 'user' });
    const dOrg = await setOrgSub(d.userId, 'pro', 'trialing', future, c);

    expect(await c.service.downgradeExpired()).toBe(2);

    expect((await c.subRepo.findByOrganizationId(aId))!.status).toBe('expired');
    expect((await c.subRepo.findByOrganizationId(bOrg))!.status).toBe('expired');
    // 未到期的不动
    expect((await c.subRepo.findByOrganizationId(dOrg))!.status).toBe('trialing');

    // 幂等
    expect(await c.service.downgradeExpired()).toBe(0);
  });
});