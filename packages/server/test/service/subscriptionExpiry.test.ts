import { describe, it, expect, beforeEach } from 'vitest';
import { SubscriptionService } from '../../src/service/subscriptionService.js';
import { PlanPolicy, resolveEffectivePlans } from '../../src/policy/planPolicy.js';
import type { PlanCode } from '../../src/domain/enums.js';
import {
  FakeUserRepo, FakePlanRepo, FakeSubscriptionRepo, FakeDeviceRepo, FakeSyncRepo,
  FakeConnectionMetaRepo, FakeOrganizationRepo, FakeMembershipRepo, FakeSeatRepo,
  FakeRegistrationRepo, makePlan,
} from '../helpers/fakeRepos.js';

const DAY = 86400000;

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
async function setOrgSub(
  userId: number,
  code: PlanCode,
  status: string,
  periodEndTime: Date | undefined,
  c: Awaited<ReturnType<typeof setup>>,
): Promise<number> {
  const m = (await c.membershipRepo.listByUser(userId)).find((x) => x.status === 'active')!;
  const plan = (await c.planRepo.findByCode(code))!;
  await c.subRepo.upsert({ organizationId: m.organizationId, planId: plan.id, status: status as any, periodEndTime, provider: 'manual' });
  return m.organizationId;
}

let c: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { c = await setup(); });

describe('SubscriptionService.ensureActive 只影响当前用户', () => {
  it('单用户到期只改自己那一行，不触发全表批量降级', async () => {
    const myOrg = await setOrgSub(c.userId, 'pro', 'active', new Date(Date.now() - DAY), c);
    const other = await c.registrationRepo.createAccount({ email: 'b@example.com', passwordHash: 'x', role: 'user' });
    const otherOrg = await setOrgSub(other.userId, 'pro', 'active', new Date(Date.now() - DAY), c);

    await c.service.ensureActive(c.userId);

    expect(c.subRepo.downgradeCalls, 'ensureActive 不应调用全表批量降级').toBe(0);
    expect(c.subRepo.expireOneCalls).toBe(1);
    expect((await c.subRepo.findByOrganizationId(myOrg))!.status).toBe('expired');
    // 别人不受影响（即便同样到期，也等他自己的请求或定时任务处理）
    expect((await c.subRepo.findByOrganizationId(otherOrg))!.status).toBe('active');
  });

  it('periodEndTime 恰好等于当前时刻：状态到期', async () => {
    const orgId = await setOrgSub(c.userId, 'pro', 'active', new Date(Date.now() - 1), c);
    const now = new Date();
    await setOrgSub(c.userId, 'pro', 'active', now, c);
    await c.service.ensureActive(c.userId, now);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('expired');
  });

  it('周期内不动，也不发任何写语句', async () => {
    const orgId = await setOrgSub(c.userId, 'pro', 'active', new Date(Date.now() + DAY), c);
    await c.service.ensureActive(c.userId);
    expect(c.subRepo.expireOneCalls).toBe(0);
    expect(c.subRepo.downgradeCalls).toBe(0);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('active');
  });

  it('trialing 过期同样由 ensureActive 降级', async () => {
    const orgId = await setOrgSub(c.userId, 'pro', 'trialing', new Date(Date.now() - DAY), c);
    await c.service.ensureActive(c.userId);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('expired');
  });

  it('trialing 仅 trialEndTime 到期（无 periodEndTime）也降级——付费门禁旁路修复', async () => {
    // createOrganization 建的 team 试用：status=trialing、trialEndTime=过去、periodEndTime=NULL
    const m = (await c.membershipRepo.listByUser(c.userId)).find((x) => x.status === 'active')!;
    const plan = (await c.planRepo.findByCode('team'))!;
    await c.subRepo.upsert({
      organizationId: m.organizationId, planId: plan.id, status: 'trialing', provider: 'manual',
      trialEndTime: new Date(Date.now() - DAY),
    });
    await c.service.ensureActive(c.userId);
    expect((await c.subRepo.findByOrganizationId(m.organizationId))!.status).toBe('expired');
  });

  it('无到期订阅时什么都不做', async () => {
    await expect(c.service.ensureActive(c.userId)).resolves.toBeUndefined();
    expect(c.subRepo.expireOneCalls).toBe(0);
    expect(c.subRepo.downgradeCalls).toBe(0);
  });
});

describe('SubscriptionService.downgradeExpired（全表，定时任务用）', () => {
  it('到期订阅统一 expired，且幂等', async () => {
    const aOrg = await setOrgSub(c.userId, 'pro', 'active', new Date(Date.now() - DAY), c);
    const other = await c.registrationRepo.createAccount({ email: 'b@example.com', passwordHash: 'x', role: 'user' });
    const bOrg = await setOrgSub(other.userId, 'team', 'active', new Date(Date.now() - DAY), c);

    expect(await c.service.downgradeExpired()).toBe(2);
    expect((await c.subRepo.findByOrganizationId(aOrg))!.status).toBe('expired');
    expect((await c.subRepo.findByOrganizationId(bOrg))!.status).toBe('expired');
    expect(await c.service.downgradeExpired()).toBe(0);
  });

  it('边界：periodEndTime 等于 now 即算到期', async () => {
    const now = new Date();
    const orgId = await setOrgSub(c.userId, 'pro', 'active', now, c);
    expect(await c.service.downgradeExpired(now)).toBe(1);
    expect((await c.subRepo.findByOrganizationId(orgId))!.status).toBe('expired');
  });

  it('trialing / canceled 到期降级，expired 是终态不再处理', async () => {
    const past = new Date(Date.now() - DAY);
    const orgIds: Record<string, number> = {};
    for (const status of ['trialing', 'canceled', 'expired'] as const) {
      const u = await c.registrationRepo.createAccount({ email: `${status}@example.com`, passwordHash: 'x', role: 'user' });
      orgIds[status] = await setOrgSub(u.userId, 'pro', status, past, c);
    }

    expect(await c.service.downgradeExpired()).toBe(2);
    expect((await c.subRepo.findByOrganizationId(orgIds.trialing))!.status).toBe('expired');
    expect((await c.subRepo.findByOrganizationId(orgIds.canceled))!.status).toBe('expired');
    expect((await c.subRepo.findByOrganizationId(orgIds.expired))!.status).toBe('expired');
  });
});