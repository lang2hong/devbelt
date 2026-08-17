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
  const rtRepo = new FakeRefreshTokenRepo();
  const syncRepo = new FakeSyncRepo();
  const connectionMetaRepo = new FakeConnectionMetaRepo();
  const service = new SubscriptionService(userRepo, planRepo, subRepo, rtRepo, syncRepo, connectionMetaRepo);
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'pro');
  return { service, userRepo, planRepo, subRepo, rtRepo, syncRepo, connectionMetaRepo, user };
}

describe('SubscriptionService.ensureActive', () => {
  it('downgrades an active-but-expired subscription and drops the user to free', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await subRepo.upsert({
      userId: user.id,
      planCode: 'pro',
      status: 'active',
      periodEndTime: new Date(Date.now() - DAY),
      provider: 'manual',
    });

    await service.ensureActive(user.id);

    expect((await subRepo.findByUserId(user.id))!.status).toBe('expired');
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });

  it('leaves a subscription that is still inside its period alone', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await subRepo.upsert({
      userId: user.id,
      planCode: 'pro',
      status: 'active',
      periodEndTime: new Date(Date.now() + DAY),
      provider: 'manual',
    });

    await service.ensureActive(user.id);

    expect((await subRepo.findByUserId(user.id))!.status).toBe('active');
    expect((await userRepo.findById(user.id))!.planCode).toBe('pro');
    expect(subRepo.downgradeCalls).toBe(0);
  });

  it('does not touch a trialing subscription even after its period end', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await subRepo.upsert({
      userId: user.id,
      planCode: 'pro',
      status: 'trialing',
      periodEndTime: new Date(Date.now() - DAY),
      provider: 'manual',
    });

    await service.ensureActive(user.id);

    expect((await subRepo.findByUserId(user.id))!.status).toBe('trialing');
    expect((await userRepo.findById(user.id))!.planCode).toBe('pro');
  });

  it('is a no-op when the user has no subscription row', async () => {
    const { service, subRepo, user } = await setup();
    await expect(service.ensureActive(user.id)).resolves.toBeUndefined();
    expect(subRepo.downgradeCalls).toBe(0);
  });
});

describe('SubscriptionService.downgradeExpired', () => {
  it('counts only the rows it actually downgraded', async () => {
    const { service, subRepo, userRepo } = await setup();
    const b = await userRepo.create('b@example.com', 'scrypt$x$y', 'user', 'pro');
    const c = await userRepo.create('c@example.com', 'scrypt$x$y', 'user', 'pro');

    await subRepo.upsert({ userId: 1, planCode: 'pro', status: 'active', periodEndTime: new Date(Date.now() - DAY), provider: 'manual' });
    await subRepo.upsert({ userId: b.id, planCode: 'pro', status: 'active', periodEndTime: new Date(Date.now() + DAY), provider: 'manual' });
    await subRepo.upsert({ userId: c.id, planCode: 'pro', status: 'canceled', periodEndTime: new Date(Date.now() - DAY), provider: 'manual' });

    expect(await service.downgradeExpired()).toBe(1);
    expect(await service.downgradeExpired()).toBe(0);
  });
});

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
