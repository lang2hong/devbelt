import { describe, expect, it, beforeEach } from 'vitest';
import { SubscriptionService } from '../../src/service/subscriptionService.js';
import {
  FakeConnectionMetaRepo,
  FakePlanRepo,
  FakeRefreshTokenRepo,
  FakeSubscriptionRepo,
  FakeSyncRepo,
  FakeUserRepo,
  makePlan,
} from '../helpers/fakeRepos.js';

/**
 * 试用期到期。
 *
 * 注册时会写一行 `status: 'trialing'`（authService.register），而到期扫描
 * ——`expireOne` 与 `downgradeExpired`——只看 `status = 'active'`。
 * 结果是 trialing 的行**永远不会被处理**：
 *
 *  - 用户注册 7 天后，`/api/me` 里的 subscription.status 一直是 trialing。
 *    界面上"试用中"永久显示，用户不知道试用早就结束了。
 *  - 这些行也永远不被 `idx_sub_status_period` 扫到，积在表里只增不减。
 *  - 眼下试用给的是 free 套餐所以没有直接的收入损失，但这是个定时炸弹:
 *    试用给付费套餐是最常见的做法，一旦 authService 的 planCode 改成 'pro'，
 *    同一段代码就变成"所有试用用户永久免费用 pro"。
 *
 * 语义：试用期结束 = expired（和付费周期结束一致）。
 */

const DAY = 86400_000;

async function setup() {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro'), makePlan('team')]);
  const subRepo = new FakeSubscriptionRepo();
  subRepo.linkUsers(userRepo);
  const rtRepo = new FakeRefreshTokenRepo();
  const syncRepo = new FakeSyncRepo();
  const cmRepo = new FakeConnectionMetaRepo();
  const service = new SubscriptionService(userRepo, planRepo, subRepo, rtRepo, syncRepo, cmRepo);
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'pro');
  return { service, userRepo, planRepo, subRepo, user };
}

let c: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { c = await setup(); });

describe('ensureActive 处理 trialing', () => {
  it('试用期已过 → 置为 expired 并降到 free', async () => {
    await c.subRepo.upsert({
      userId: c.user.id, planCode: 'pro', status: 'trialing',
      periodEndTime: new Date(Date.now() - DAY), provider: 'manual',
    });

    await c.service.ensureActive(c.user.id);

    expect((await c.subRepo.findByUserId(c.user.id))!.status).toBe('expired');
    expect((await c.userRepo.findById(c.user.id))!.planCode).toBe('free');
  });

  it('试用期未到 → 保持 trialing', async () => {
    await c.subRepo.upsert({
      userId: c.user.id, planCode: 'pro', status: 'trialing',
      periodEndTime: new Date(Date.now() + DAY), provider: 'manual',
    });

    await c.service.ensureActive(c.user.id);

    expect((await c.subRepo.findByUserId(c.user.id))!.status).toBe('trialing');
    expect((await c.userRepo.findById(c.user.id))!.planCode).toBe('pro');
  });

  it('边界：结束时刻恰好等于 now 也算到期', async () => {
    const now = new Date();
    await c.subRepo.upsert({
      userId: c.user.id, planCode: 'pro', status: 'trialing',
      periodEndTime: now, provider: 'manual',
    });
    await c.service.ensureActive(c.user.id, now);
    expect((await c.subRepo.findByUserId(c.user.id))!.status).toBe('expired');
  });

  /**
   * canceled 是用户主动取消、但仍在已付周期内的状态 —— 它到期后同样要变
   * expired。不处理的话，一个取消过的用户会一直保持付费套餐。
   */
  it('canceled 到期同样降级', async () => {
    await c.subRepo.upsert({
      userId: c.user.id, planCode: 'pro', status: 'canceled',
      periodEndTime: new Date(Date.now() - DAY), provider: 'manual',
    });
    await c.service.ensureActive(c.user.id);
    expect((await c.subRepo.findByUserId(c.user.id))!.status).toBe('expired');
    expect((await c.userRepo.findById(c.user.id))!.planCode).toBe('free');
  });

  it('已经是 expired 的不再重复处理', async () => {
    await c.subRepo.upsert({
      userId: c.user.id, planCode: 'free', status: 'expired',
      periodEndTime: new Date(Date.now() - DAY), provider: 'manual',
    });
    c.subRepo.expireOneCalls = 0;
    await c.service.ensureActive(c.user.id);
    expect(c.subRepo.expireOneCalls).toBe(0);
  });
});

describe('downgradeExpired 处理 trialing', () => {
  it('批量降级覆盖 trialing 与 canceled', async () => {
    const b = await c.userRepo.create('b@example.com', 'scrypt$x$y', 'user', 'pro');
    const d = await c.userRepo.create('d@example.com', 'scrypt$x$y', 'user', 'pro');
    const past = new Date(Date.now() - DAY);
    const future = new Date(Date.now() + DAY);

    await c.subRepo.upsert({ userId: c.user.id, planCode: 'pro', status: 'trialing', periodEndTime: past, provider: 'manual' });
    await c.subRepo.upsert({ userId: b.id, planCode: 'pro', status: 'canceled', periodEndTime: past, provider: 'manual' });
    await c.subRepo.upsert({ userId: d.id, planCode: 'pro', status: 'trialing', periodEndTime: future, provider: 'manual' });

    expect(await c.service.downgradeExpired()).toBe(2);

    expect((await c.subRepo.findByUserId(c.user.id))!.status).toBe('expired');
    expect((await c.subRepo.findByUserId(b.id))!.status).toBe('expired');
    // 未到期的不动
    expect((await c.subRepo.findByUserId(d.id))!.status).toBe('trialing');
    expect((await c.userRepo.findById(d.id))!.planCode).toBe('pro');

    // 幂等
    expect(await c.service.downgradeExpired()).toBe(0);
  });
});
