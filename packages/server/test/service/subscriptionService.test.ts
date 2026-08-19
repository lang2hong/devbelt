import { describe, it, expect } from 'vitest';
import { SubscriptionService } from '../../src/service/subscriptionService.js';
import { EntityNotFoundError } from '../../src/domain/errors.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeRefreshTokenRepo,
  FakeSyncRepo,
  FakeConnectionMetaRepo,
  makePlan,
} from '../helpers/fakeRepos.js';

const DAY = 86400000;

async function setup() {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([
    makePlan('free', { maxDevices: 2, syncQuotaBytes: 1024 }),
    makePlan('pro', { maxDevices: 5, syncQuotaBytes: 10240 }),
  ]);
  const subRepo = new FakeSubscriptionRepo();
  // 真实现的 expireOne / downgradeExpired 是一条语句同时改 subscriptions 与 users；
  // fake 要链上 userRepo 才能复刻「用户被降到 free」这一半。
  subRepo.linkUsers(userRepo);
  const rtRepo = new FakeRefreshTokenRepo();
  const syncRepo = new FakeSyncRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
  const service = new SubscriptionService(userRepo, planRepo, subRepo, rtRepo, syncRepo, connectionMetaRepo);
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'pro');
  return { service, userRepo, planRepo, subRepo, rtRepo, syncRepo, connectionMetaRepo, user };
}

// ensureActive / downgradeExpired 的行为（单用户 vs 全表、边界比较符、
// users.plan_code 是否跟着降）集中在 subscriptionExpiry.test.ts，此处不重复。

describe('SubscriptionService.getMe', () => {
  it('assembles user + plan + subscription + usage without the password hash', async () => {
    const { service, subRepo, rtRepo, syncRepo, user } = await setup();
    await subRepo.upsert({
      userId: user.id,
      planCode: 'pro',
      status: 'active',
      periodEndTime: new Date(Date.now() + DAY),
      provider: 'manual',
    });
    await rtRepo.create({ userId: user.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + DAY) });
    await rtRepo.create({ userId: user.id, tokenHash: 'h2', expiresTime: new Date(Date.now() + DAY) });
    await syncRepo.putSection(user.id, 'connections', 'x'.repeat(300), 1);
    await syncRepo.putSection(user.id, 'queries', 'y'.repeat(200), 1);

    const me = await service.getMe(user.id);

    expect('passwordHash' in me.user).toBe(false);
    expect(me.user.email).toBe('a@example.com');
    expect(me.plan.code).toBe('pro');
    expect(me.subscription?.status).toBe('active');
    expect(me.usage).toEqual({ devices: 2, connections: 0, syncBytes: 500, history: 0 });
  });

  it('excludes revoked or expired sessions from usage', async () => {
    const { service, rtRepo, user } = await setup();
    const live = await rtRepo.create({ userId: user.id, tokenHash: 'h1', expiresTime: new Date(Date.now() + DAY) });
    const revoked = await rtRepo.create({ userId: user.id, tokenHash: 'h2', expiresTime: new Date(Date.now() + DAY) });
    await rtRepo.revoke(revoked.id);
    await rtRepo.create({ userId: user.id, tokenHash: 'h3', expiresTime: new Date(Date.now() - DAY) });

    const me = await service.getMe(user.id);
    expect(me.usage.devices).toBe(1);
    expect(live.revokedTime).toBeUndefined();
  });

  it('reflects the downgrade performed by ensureActive', async () => {
    const { service, subRepo, user } = await setup();
    await subRepo.upsert({
      userId: user.id,
      planCode: 'pro',
      status: 'active',
      periodEndTime: new Date(Date.now() - DAY),
      provider: 'manual',
    });

    const me = await service.getMe(user.id);
    expect(me.user.planCode).toBe('free');
    expect(me.plan.code).toBe('free');
    expect(me.subscription?.status).toBe('expired');
  });

  it('rejects an unknown user', async () => {
    const { service } = await setup();
    await expect(service.getMe(4242)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('throws when the user references a plan that does not exist', async () => {
    const { service, userRepo, planRepo, user } = await setup();
    planRepo.plans.delete('pro');
    expect((await userRepo.findById(user.id))!.planCode).toBe('pro');
    await expect(service.getMe(user.id)).rejects.toThrow('plan not found: pro');
  });
});
