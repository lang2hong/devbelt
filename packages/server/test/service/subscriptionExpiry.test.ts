import { describe, it, expect } from 'vitest';
import { SubscriptionService } from '../../src/service/subscriptionService.js';
import {
  FakeUserRepo,
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeDeviceRepo,
  FakeSyncRepo,
  FakeConnectionMetaRepo,
  makePlan,
} from '../helpers/fakeRepos.js';

const DAY = 86400000;

async function setup() {
  const userRepo = new FakeUserRepo();
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro')]);
  const subRepo = new FakeSubscriptionRepo();
  // 真实现的 downgradeExpired / expireOne 都是 JOIN users 一条语句改两张表。
  // fake 必须也能改到 users，否则「批量降级到底有没有把用户降到 free」
  // 在单测里完全看不见（此前 fake 只改了 subscriptions.plan_code —— 一个
  // 真实现根本不碰的列）。
  subRepo.linkUsers(userRepo);
  const service = new SubscriptionService(
    userRepo, planRepo, subRepo, new FakeDeviceRepo(), new FakeSyncRepo(), new FakeConnectionMetaRepo(),
  );
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'pro');
  return { service, userRepo, subRepo, user };
}

describe('SubscriptionService.ensureActive 只影响当前用户', () => {
  /**
   * ensureActive 挂在 /api/me 上 —— 每个客户端启动、每次刷新面板都会走一次。
   * 旧实现在这里调 `downgradeExpired(now)`，那是一条
   * `UPDATE subscriptions JOIN users` 的**全表**语句：一个用户的订阅到期，
   * 就让所有在线用户的 /api/me 各自触发一次全表 JOIN UPDATE，并发下互相锁等待。
   */
  it('单用户到期只改自己那一行，不触发全表批量降级', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    const other = await userRepo.create('b@example.com', 'scrypt$x$y', 'user', 'pro');
    await subRepo.upsert({ userId: user.id, planCode: 'pro', status: 'active', periodEndTime: new Date(Date.now() - DAY), provider: 'manual' });
    await subRepo.upsert({ userId: other.id, planCode: 'pro', status: 'active', periodEndTime: new Date(Date.now() - DAY), provider: 'manual' });

    await service.ensureActive(user.id);

    expect(subRepo.downgradeCalls, 'ensureActive 不应调用全表批量降级').toBe(0);
    expect(subRepo.expireOneCalls).toBe(1);
    // 自己降级了
    expect((await subRepo.findByUserId(user.id))!.status).toBe('expired');
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
    // 别人不受影响（即便同样到期，也该等他自己的请求或定时任务来处理）
    expect((await subRepo.findByUserId(other.id))!.status).toBe('active');
    expect((await userRepo.findById(other.id))!.planCode).toBe('pro');
  });

  /**
   * 比较符不一致造成的死循环：service 判 `periodEndTime <= now` 认为该降级，
   * 而 SQL 用 `period_end_time < ?` 一行都匹配不到 —— 旧实现却仍然单独执行
   * `updatePlan(userId, 'free')`。结果 user.plan_code = free 而
   * subscription.status 还是 active，此后每次 /api/me 都重新触发一次全表 UPDATE。
   */
  it('periodEndTime 恰好等于当前时刻：状态与套餐必须一起变，不留半套', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    const now = new Date();
    await subRepo.upsert({ userId: user.id, planCode: 'pro', status: 'active', periodEndTime: now, provider: 'manual' });

    await service.ensureActive(user.id, now);

    const sub = (await subRepo.findByUserId(user.id))!;
    expect(sub.status).toBe('expired');
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });

  it('周期内不动，也不发任何写语句', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await subRepo.upsert({ userId: user.id, planCode: 'pro', status: 'active', periodEndTime: new Date(Date.now() + DAY), provider: 'manual' });

    await service.ensureActive(user.id);

    expect(subRepo.expireOneCalls).toBe(0);
    expect(subRepo.downgradeCalls).toBe(0);
    expect((await userRepo.findById(user.id))!.planCode).toBe('pro');
  });

  /**
   * 这条用例原先断言的是**相反的行为**——「trialing 过期不由 ensureActive 处理」，
   * 还给了个听起来合理的理由（"试用到期是支付流程的事"）。那是把缺陷写成了期望：
   * 没有任何支付流程会来处理 trialing，结果就是注册写下的 trialing 行永远
   * 停在那里，用户 7 天后 /api/me 仍显示"试用中"。
   * trialing 与 canceled 的到期处理见 trialExpiry.test.ts。
   */
  it('trialing 过期同样由 ensureActive 降级', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await subRepo.upsert({ userId: user.id, planCode: 'pro', status: 'trialing', periodEndTime: new Date(Date.now() - DAY), provider: 'manual' });

    await service.ensureActive(user.id);

    expect((await subRepo.findByUserId(user.id))!.status).toBe('expired');
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });

  it('无订阅行时什么都不做', async () => {
    const { service, subRepo, user } = await setup();
    await expect(service.ensureActive(user.id)).resolves.toBeUndefined();
    expect(subRepo.expireOneCalls).toBe(0);
    expect(subRepo.downgradeCalls).toBe(0);
  });
});

describe('SubscriptionService.downgradeExpired（全表，定时任务用）', () => {
  it('把用户的 plan_code 一起降到 free', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    const b = await userRepo.create('b@example.com', 'scrypt$x$y', 'user', 'team');
    await subRepo.upsert({ userId: user.id, planCode: 'pro', status: 'active', periodEndTime: new Date(Date.now() - DAY), provider: 'manual' });
    await subRepo.upsert({ userId: b.id, planCode: 'team', status: 'active', periodEndTime: new Date(Date.now() - DAY), provider: 'manual' });

    expect(await service.downgradeExpired()).toBe(2);

    // 关键：users.plan_code 必须跟着降。此前 fake 改的是 subscriptions.plan_code，
    // 于是这条不变量在单测里从未被验证过。
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
    expect((await userRepo.findById(b.id))!.planCode).toBe('free');
    // 幂等：第二次没有可降的行
    expect(await service.downgradeExpired()).toBe(0);
  });

  it('边界与 ensureActive 一致：periodEndTime 等于 now 即算到期', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    const now = new Date();
    await subRepo.upsert({ userId: user.id, planCode: 'pro', status: 'active', periodEndTime: now, provider: 'manual' });

    expect(await service.downgradeExpired(now)).toBe(1);
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });

  /**
   * 同上：原先断言「trialing / canceled / expired 都不动」，把漏处理写成了期望。
   * 现在 trialing 与 canceled 都要降级，只有 expired 是终态不再重复处理。
   */
  it('trialing / canceled 到期降级，expired 是终态不再处理', async () => {
    const { service, subRepo, userRepo } = await setup();
    const past = new Date(Date.now() - DAY);
    const ids: Record<string, number> = {};
    for (const [i, status] of (['trialing', 'canceled', 'expired'] as const).entries()) {
      const u = await userRepo.create(`s${i}@example.com`, 'scrypt$x$y', 'user', 'pro');
      ids[status] = u.id;
      await subRepo.upsert({ userId: u.id, planCode: 'pro', status, periodEndTime: past, provider: 'manual' });
    }

    expect(await service.downgradeExpired()).toBe(2);

    expect((await subRepo.findByUserId(ids.trialing))!.status).toBe('expired');
    expect((await subRepo.findByUserId(ids.canceled))!.status).toBe('expired');
    expect((await userRepo.findById(ids.trialing))!.planCode).toBe('free');
    // 已是 expired 的那个用户不该被这次调用计入，plan 也不该被再改一遍
    expect((await userRepo.findById(ids.expired))!.planCode).toBe('pro');
  });
});
