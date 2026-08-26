import { describe, it, expect } from 'vitest';
import { SubscriptionService } from '../../src/service/subscriptionService.js';
import { PlanPolicy, resolveEffectivePlans } from '../../src/policy/planPolicy.js';
import { EntityNotFoundError } from '../../src/domain/errors.js';
import type { PlanCode } from '../../src/domain/enums.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeDeviceRepo,
  FakeSyncRepo,
  FakeConnectionMetaRepo,
  FakeOrganizationRepo,
  FakeMembershipRepo,
  FakeSeatRepo,
  FakeRegistrationRepo,
  makePlan,
} from '../helpers/fakeRepos.js';

const DAY = 86400000;

async function setup() {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([
    makePlan('free', { perSeatMaxDevices: 2, perUserPrivateSyncQuotaBytes: 1024 }),
    makePlan('pro', { perSeatMaxDevices: 5, perUserPrivateSyncQuotaBytes: 10240 }),
  ]);
  const subRepo = new FakeSubscriptionRepo();
  const orgRepo = new FakeOrganizationRepo();
  const membershipRepo = new FakeMembershipRepo();
  const seatRepo = new FakeSeatRepo();
  const registrationRepo = new FakeRegistrationRepo({
    users: userRepo, orgs: orgRepo, memberships: membershipRepo, subs: subRepo, seats: seatRepo, plans: planRepo,
  });
  const planPolicy = new PlanPolicy((id) => resolveEffectivePlans(id, { membershipRepo, subRepo, planRepo }));
  const deviceRepo = new FakeDeviceRepo();
  const syncRepo = new FakeSyncRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
  const service = new SubscriptionService(
    userRepo, planRepo, subRepo, membershipRepo, orgRepo,
    deviceRepo, syncRepo, connectionMetaRepo, planPolicy,
  );
  const { userId } = await registrationRepo.createAccount({ email: 'a@example.com', passwordHash: 'scrypt$x$y', role: 'user' });
  const user = (await userRepo.findById(userId))!;
  return { service, userRepo, planRepo, subRepo, membershipRepo, deviceRepo, syncRepo, connectionMetaRepo, user };
}

/** 把某用户 personal org 的订阅切到指定套餐 */
async function setPlan(userId: number, code: PlanCode, status: string, periodEndTime: Date, deps: {
  subRepo: FakeSubscriptionRepo;
  membershipRepo: FakeMembershipRepo;
  planRepo: FakePlanRepo;
}): Promise<void> {
  const m = (await deps.membershipRepo.listByUser(userId)).find((x) => x.status === 'active')!;
  const plan = (await deps.planRepo.findByCode(code))!;
  await deps.subRepo.upsert({ organizationId: m.organizationId, planId: plan.id, status: status as any, periodEndTime, provider: 'manual' });
}

describe('SubscriptionService.getMe', () => {
  it('assembles user + plan + subscription + usage without the password hash', async () => {
    const { service, subRepo, membershipRepo, planRepo, deviceRepo, syncRepo, user } = await setup();
    await setPlan(user.id, 'pro', 'active', new Date(Date.now() + DAY), { subRepo, membershipRepo, planRepo });
    await deviceRepo.upsert({ userId: user.id, deviceId: 'd1' } as any);
    await deviceRepo.bind(user.id, 'd1');
    await deviceRepo.upsert({ userId: user.id, deviceId: 'd2' } as any);
    await deviceRepo.bind(user.id, 'd2');
    await syncRepo.putSection(user.id, 'connections', 'x'.repeat(300), 1);
    await syncRepo.putSection(user.id, 'queries', 'y'.repeat(200), 1);

    const me = await service.getMe(user.id);

    expect('passwordHash' in me.user).toBe(false);
    expect(me.user.email).toBe('a@example.com');
    expect(me.plan.code).toBe('pro');
    expect(me.subscription?.status).toBe('active');
    expect(me.usage).toEqual({ devices: 2, connections: 0, syncBytes: 500, history: 0 });
  });

  it('counts only bound devices (revoked/unbound excluded) in usage', async () => {
    const { service, deviceRepo, user } = await setup();
    await deviceRepo.upsert({ userId: user.id, deviceId: 'bound' } as any);
    await deviceRepo.bind(user.id, 'bound');
    await deviceRepo.upsert({ userId: user.id, deviceId: 'unbound' } as any);

    const me = await service.getMe(user.id);
    expect(me.usage.devices).toBe(1);
  });

  it('reflects the downgrade performed by ensureActive（plan 回落到 free）', async () => {
    const { service, subRepo, membershipRepo, planRepo, user } = await setup();
    await setPlan(user.id, 'pro', 'active', new Date(Date.now() - DAY), { subRepo, membershipRepo, planRepo });

    const me = await service.getMe(user.id);
    expect(me.plan.code).toBe('free'); // 到期后无活跃席位，回落到 free 保底
    expect(me.subscription?.status).toBe('expired');
  });

  it('rejects an unknown user', async () => {
    const { service } = await setup();
    await expect(service.getMe(4242)).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});