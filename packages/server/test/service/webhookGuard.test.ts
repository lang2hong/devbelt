import { describe, expect, it, beforeEach } from 'vitest';
import { PaymentService } from '../../src/service/paymentService.js';
import {
  FakePlanRepo,
  FakeSubscriptionRepo,
  FakeUserRepo,
  FakeWebhookEventRepo,
  makePlan,
} from '../helpers/fakeRepos.js';
import type { PaymentProvider, WebhookEvent } from '../../src/adapter/paymentProvider.js';
import type { PaymentProvider as ProviderName, PlanCode } from '../../src/domain/enums.js';
import { ValidationError } from '../../src/domain/errors.js';

/**
 * webhook 事件的落库前校验与幂等。
 *
 * `applyWebhookEvent` 的入参来自**支付商发来的载荷**（经适配器解析）。
 * 验签只证明"这条消息来自支付商"，不证明里面的字段是本系统认得的值 ——
 * 而此前这些字段被直接写库：
 *
 *  - `planCode` 任意字符串 → `users.plan_code` 无外键指向 `plans.code`
 *    → 孤儿套餐码 → 之后每次 `/api/me` 因 `plan not found` 抛裸 Error 变 500。
 *    用户彻底用不了，而排查要从"支付商发来什么"一路倒推。
 *    admin 侧已经做了白名单校验（adminService.updateUser），webhook 侧没做 ——
 *    同一个字段两条写入路径，只有一条设防。
 *  - `userId` 不存在 → 靠数据库外键报错，表现为 500 而不是明确的拒绝。
 *  - 同一事件被投递多次 → 重复处理。支付商在超时/5xx 时**必然重试**
 *    （Stripe 会重试到 3 天），`subscription_renewed` 处理两次就把周期
 *    延长两倍，等于白送一个月。
 */

class StubAdapter implements PaymentProvider {
  readonly name = 'stripe' as ProviderName;
  next?: WebhookEvent;
  async createSubscription(userId: number) {
    return { externalId: `x-${userId}`, periodEnd: new Date(Date.now() + 30 * 86400_000) };
  }
  async cancelSubscription(): Promise<void> {}
  async handleWebhook(): Promise<WebhookEvent> {
    if (!this.next) throw new Error('no event queued');
    return this.next;
  }
}

const DAY = 86400_000;

interface Ctx {
  svc: PaymentService;
  userRepo: FakeUserRepo;
  subRepo: FakeSubscriptionRepo;
  eventRepo: FakeWebhookEventRepo;
  adapter: StubAdapter;
  userId: number;
}

async function setup(): Promise<Ctx> {
  const userRepo = new FakeUserRepo();
  const subRepo = new FakeSubscriptionRepo();
  subRepo.linkUsers(userRepo);
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro'), makePlan('team')]);
  const eventRepo = new FakeWebhookEventRepo();
  const svc = new PaymentService(subRepo, userRepo, planRepo, eventRepo);
  const adapter = new StubAdapter();
  svc.registerProvider(adapter);
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'free');
  return { svc, userRepo, subRepo, eventRepo, adapter, userId: user.id };
}

function evt(over: Partial<WebhookEvent> & { userId: number }): WebhookEvent {
  return {
    type: 'subscription_renewed',
    planCode: 'pro' as PlanCode,
    periodEnd: new Date(Date.now() + 30 * DAY),
    externalId: 'ext-1',
    provider: 'stripe' as ProviderName,
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    ...over,
  } as WebhookEvent;
}

let c: Ctx;
beforeEach(async () => { c = await setup(); });

describe('planCode 白名单', () => {
  it('未知 planCode 被拒绝，用户套餐不变', async () => {
    await expect(c.svc.applyWebhookEvent(evt({ userId: c.userId, planCode: 'enterprise' as PlanCode })))
      .rejects.toBeInstanceOf(ValidationError);
    expect((await c.userRepo.findById(c.userId))!.planCode).toBe('free');
    expect(await c.subRepo.findByUserId(c.userId)).toBeUndefined();
  });

  /**
   * 校验按 plans 表的**实际内容**判断，不是硬编码的三个字面量。
   * 后台可以新增套餐码，白名单必须跟着走，否则新套餐的回调会被误拒。
   */
  it('白名单取自 plans 表：表里有就放行', async () => {
    const { userRepo, subRepo, eventRepo } = c;
    const planRepo = new FakePlanRepo([makePlan('free'), makePlan('startup' as PlanCode)]);
    const s2 = new PaymentService(subRepo, userRepo, planRepo, eventRepo);
    s2.registerProvider(c.adapter);
    await s2.applyWebhookEvent(evt({ userId: c.userId, planCode: 'startup' as PlanCode }));
    expect((await userRepo.findById(c.userId))!.planCode).toBe('startup');
  });

  it('表里没有就拒绝，即使是常见名字', async () => {
    const { userRepo, subRepo, eventRepo } = c;
    const planRepo = new FakePlanRepo([makePlan('free')]);
    const s2 = new PaymentService(subRepo, userRepo, planRepo, eventRepo);
    s2.registerProvider(c.adapter);
    await expect(s2.applyWebhookEvent(evt({ userId: c.userId, planCode: 'pro' as PlanCode })))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('取消/过期事件同样校验 planCode', async () => {
    await c.svc.applyWebhookEvent(evt({ userId: c.userId }));
    await expect(c.svc.applyWebhookEvent(evt({
      userId: c.userId, type: 'subscription_canceled', planCode: 'bogus' as PlanCode,
    }))).rejects.toBeInstanceOf(ValidationError);
    // 原状态未被破坏
    expect((await c.subRepo.findByUserId(c.userId))!.status).toBe('active');
  });
});

describe('userId 校验', () => {
  it('不存在的用户被拒绝，不留下孤儿订阅', async () => {
    await expect(c.svc.applyWebhookEvent(evt({ userId: 999999 })))
      .rejects.toThrow(/user/i);
    expect(c.subRepo.subs.size).toBe(0);
  });

  it('非法 userId（0 / 负数 / NaN）被拒绝', async () => {
    for (const bad of [0, -1, Number.NaN]) {
      await expect(c.svc.applyWebhookEvent(evt({ userId: bad })))
        .rejects.toThrow();
    }
  });
});

describe('幂等', () => {
  /**
   * 支付商在超时或收到 5xx 时**必然重试**。同一个 renewed 事件处理两次，
   * 周期就被延长两倍 —— 白送一个月。
   */
  it('相同 eventId 只生效一次', async () => {
    const e = evt({ userId: c.userId, eventId: 'evt_same' });
    await c.svc.applyWebhookEvent(e);
    const first = await c.subRepo.findByUserId(c.userId);

    // 第二次投递：不抛错（对支付商要回 200，否则它会一直重试），但不再改状态
    await c.svc.applyWebhookEvent({ ...e, periodEnd: new Date(Date.now() + 999 * DAY) });
    const second = await c.subRepo.findByUserId(c.userId);
    expect(second!.periodEndTime.getTime()).toBe(first!.periodEndTime.getTime());
  });

  it('不同 eventId 各自生效', async () => {
    await c.svc.applyWebhookEvent(evt({ userId: c.userId, eventId: 'evt_1' }));
    const later = new Date(Date.now() + 60 * DAY);
    await c.svc.applyWebhookEvent(evt({ userId: c.userId, eventId: 'evt_2', periodEnd: later }));
    expect((await c.subRepo.findByUserId(c.userId))!.periodEndTime.getTime()).toBe(later.getTime());
  });

  /**
   * 幂等记录必须在**处理成功之后**写。
   *
   * 先记后做的话，一次处理中途失败（DB 抖动）会让这个事件被永久标记为
   * "已处理"—— 支付商的重试全部被幂等挡掉，用户付了钱但套餐没生效，
   * 而且没有任何重试机会。
   */
  it('处理失败时不记幂等，重试仍能生效', async () => {
    const e = evt({ userId: c.userId, eventId: 'evt_retry' });
    c.subRepo.failNextUpsert = true;
    await expect(c.svc.applyWebhookEvent(e)).rejects.toThrow();
    expect(await c.eventRepo.seen('stripe', 'evt_retry')).toBe(false);

    // 重试成功
    await c.svc.applyWebhookEvent(e);
    expect((await c.subRepo.findByUserId(c.userId))!.status).toBe('active');
  });

  /**
   * eventId 的唯一性只在同一支付商内成立。两家支付商各自用 `evt_1`
   * 编号是完全可能的，跨商去重会把第二家的第一个事件吃掉。
   */
  it('eventId 按 provider 分别去重', async () => {
    const other = new StubAdapter();
    (other as any).name = 'lemonsqueezy';
    c.svc.registerProvider(other);

    await c.svc.applyWebhookEvent(evt({ userId: c.userId, eventId: 'evt_1' }));
    const later = new Date(Date.now() + 60 * DAY);
    await c.svc.applyWebhookEvent(evt({
      userId: c.userId, eventId: 'evt_1', provider: 'lemonsqueezy' as ProviderName, periodEnd: later,
    }));
    expect((await c.subRepo.findByUserId(c.userId))!.periodEndTime.getTime()).toBe(later.getTime());
  });

  /**
   * 没有 eventId 时不能静默跳过去重、也不能拒绝 —— 有些支付商不提供事件 id。
   * 退回到按内容摘要去重：同样的 (provider, type, userId, externalId, periodEnd)
   * 视为同一事件。
   */
  it('缺少 eventId 时按事件内容去重', async () => {
    const base = evt({ userId: c.userId });
    delete (base as any).eventId;
    await c.svc.applyWebhookEvent(base);
    const first = await c.subRepo.findByUserId(c.userId);
    await c.svc.applyWebhookEvent({ ...base });
    expect((await c.subRepo.findByUserId(c.userId))!.updateTime.getTime())
      .toBe(first!.updateTime.getTime());
  });

  /**
   * 摘要方案必须真的**基于内容**。
   *
   * 用一个固定字符串当键也能让上一条用例通过（两次投递内容相同），
   * 但那会把之后**所有**无 eventId 的事件全部当成重复吞掉 ——
   * 一个不提供事件 id 的支付商接进来，第二次续费就静默失效了。
   */
  it('缺少 eventId 且内容不同 → 各自生效', async () => {
    const first = evt({ userId: c.userId });
    delete (first as any).eventId;
    await c.svc.applyWebhookEvent(first);

    const later = new Date(Date.now() + 60 * DAY);
    const second = evt({ userId: c.userId, periodEnd: later });
    delete (second as any).eventId;
    await c.svc.applyWebhookEvent(second);

    expect((await c.subRepo.findByUserId(c.userId))!.periodEndTime.getTime()).toBe(later.getTime());
  });
});

describe('handleWebhook 端到端（含幂等与校验）', () => {
  it('合法事件生效并记录', async () => {
    c.adapter.next = evt({ userId: c.userId, eventId: 'evt_e2e' });
    await c.svc.handleWebhook('stripe' as ProviderName, Buffer.from('{}'), 'sig');
    expect((await c.userRepo.findById(c.userId))!.planCode).toBe('pro');
    expect(await c.eventRepo.seen('stripe', 'evt_e2e')).toBe(true);
  });

  it('重复投递返回成功但不重复生效', async () => {
    c.adapter.next = evt({ userId: c.userId, eventId: 'evt_dup' });
    await c.svc.handleWebhook('stripe' as ProviderName, Buffer.from('{}'), 'sig');
    const first = (await c.subRepo.findByUserId(c.userId))!.periodEndTime.getTime();

    c.adapter.next = evt({
      userId: c.userId, eventId: 'evt_dup', periodEnd: new Date(Date.now() + 999 * DAY),
    });
    await expect(c.svc.handleWebhook('stripe' as ProviderName, Buffer.from('{}'), 'sig'))
      .resolves.toBeUndefined();
    expect((await c.subRepo.findByUserId(c.userId))!.periodEndTime.getTime()).toBe(first);
  });
});
