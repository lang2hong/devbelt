import { describe, expect, it, beforeEach } from 'vitest';
import { PaymentService } from '../../src/service/paymentService.js';
import {
  FakePlanRepo, FakeSubscriptionRepo, FakeOrganizationRepo, FakeOrderRepo, FakeSeatRepo, FakeWebhookEventRepo, FakeMembershipRepo, makePlan,
} from '../helpers/fakeRepos.js';
import type { PaymentProvider, WebhookEvent } from '../../src/adapter/paymentProvider.js';
import type { PaymentProvider as ProviderName, PlanCode } from '../../src/domain/enums.js';
import { ValidationError } from '../../src/domain/errors.js';

/**
 * webhook 事件的落库前校验与幂等（v2：订阅挂组织）。
 * `applyWebhookEvent` 的入参来自支付商载荷，验签只证明消息来源，不证明字段合法：
 *  - org/planCode 不存在 → 之前靠外键报 500，现在前置校验明确拒绝
 *  - 重复投递（支付商超时/5xx 必重试）→ 幂等去重，避免周期被延长两倍
 */

class StubAdapter implements PaymentProvider {
  readonly name = 'stripe' as ProviderName;
  next?: WebhookEvent;
  async createSubscription(organizationId: number) {
    return { externalId: `x-${organizationId}`, periodEnd: new Date(Date.now() + 30 * 86400_000) };
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
  planRepo: FakePlanRepo;
  subRepo: FakeSubscriptionRepo;
  orgRepo: FakeOrganizationRepo;
  orderRepo: FakeOrderRepo;
  seatRepo: FakeSeatRepo;
  eventRepo: FakeWebhookEventRepo;
  membershipRepo: FakeMembershipRepo;
  adapter: StubAdapter;
  orgId: number;
}

async function setup(): Promise<Ctx> {
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro'), makePlan('team')]);
  const subRepo = new FakeSubscriptionRepo();
  const orgRepo = new FakeOrganizationRepo();
  const orderRepo = new FakeOrderRepo();
  const seatRepo = new FakeSeatRepo();
  const eventRepo = new FakeWebhookEventRepo();
  const membershipRepo = new FakeMembershipRepo();
  const svc = new PaymentService(subRepo, orgRepo, planRepo, orderRepo, seatRepo, eventRepo, membershipRepo);
  const adapter = new StubAdapter();
  svc.registerProvider(adapter);
  const org = await orgRepo.create({ name: 'Acme', type: 'team', ownerUserId: 1 });
  return { svc, planRepo, subRepo, orgRepo, orderRepo, seatRepo, eventRepo, membershipRepo, adapter, orgId: org.id };
}

function evt(over: Partial<WebhookEvent> & { organizationId: number }): WebhookEvent {
  return {
    type: 'subscription_renewed',
    planCode: 'pro' as PlanCode,
    seatDelta: 0,
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
  it('未知 planCode 被拒绝，不写订阅', async () => {
    await expect(c.svc.applyWebhookEvent(evt({ organizationId: c.orgId, planCode: 'enterprise' as PlanCode })))
      .rejects.toBeInstanceOf(ValidationError);
    expect(await c.subRepo.findByOrganizationId(c.orgId)).toBeUndefined();
  });

  it('白名单取自 plans 表：表里有就放行', async () => {
    const planRepo = new FakePlanRepo([makePlan('free'), makePlan('startup' as PlanCode)]);
    const s2 = new PaymentService(c.subRepo, c.orgRepo, planRepo, c.orderRepo, c.seatRepo, c.eventRepo, c.membershipRepo);
    s2.registerProvider(c.adapter);
    await s2.applyWebhookEvent(evt({ organizationId: c.orgId, planCode: 'startup' as PlanCode }));
    const sub = (await c.subRepo.findByOrganizationId(c.orgId))!;
    expect(sub.planId).toBe((await planRepo.findByCode('startup' as PlanCode))!.id);
  });

  it('表里没有就拒绝，即使是常见名字', async () => {
    const planRepo = new FakePlanRepo([makePlan('free')]);
    const s2 = new PaymentService(c.subRepo, c.orgRepo, planRepo, c.orderRepo, c.seatRepo, c.eventRepo, c.membershipRepo);
    s2.registerProvider(c.adapter);
    await expect(s2.applyWebhookEvent(evt({ organizationId: c.orgId, planCode: 'pro' as PlanCode })))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('取消/过期事件同样校验 planCode', async () => {
    await c.svc.applyWebhookEvent(evt({ organizationId: c.orgId }));
    await expect(c.svc.applyWebhookEvent(evt({
      organizationId: c.orgId, type: 'subscription_canceled', planCode: 'bogus' as PlanCode,
    }))).rejects.toBeInstanceOf(ValidationError);
    expect((await c.subRepo.findByOrganizationId(c.orgId))!.status).toBe('active');
  });
});

describe('organizationId 校验', () => {
  it('不存在的组织被拒绝，不留下孤儿订阅', async () => {
    await expect(c.svc.applyWebhookEvent(evt({ organizationId: 999999 })))
      .rejects.toThrow(/organization/i);
    expect(c.subRepo.subs.size).toBe(0);
  });

  it('非法 organizationId（0 / 负数 / NaN）被拒绝', async () => {
    for (const bad of [0, -1, Number.NaN]) {
      await expect(c.svc.applyWebhookEvent(evt({ organizationId: bad })))
        .rejects.toThrow();
    }
  });
});

describe('幂等', () => {
  it('相同 eventId 只生效一次', async () => {
    const e = evt({ organizationId: c.orgId, eventId: 'evt_same' });
    await c.svc.applyWebhookEvent(e);
    const first = await c.subRepo.findByOrganizationId(c.orgId);

    await c.svc.applyWebhookEvent({ ...e, periodEnd: new Date(Date.now() + 999 * DAY) });
    const second = await c.subRepo.findByOrganizationId(c.orgId);
    expect(second!.periodEndTime!.getTime()).toBe(first!.periodEndTime!.getTime());
  });

  it('不同 eventId 各自生效', async () => {
    await c.svc.applyWebhookEvent(evt({ organizationId: c.orgId, eventId: 'evt_1' }));
    const later = new Date(Date.now() + 60 * DAY);
    await c.svc.applyWebhookEvent(evt({ organizationId: c.orgId, eventId: 'evt_2', periodEnd: later }));
    expect((await c.subRepo.findByOrganizationId(c.orgId))!.periodEndTime!.getTime()).toBe(later.getTime());
  });

  it('处理失败时事件保持已记录（不 forget，防毒消息死循环，需人工排查）', async () => {
    const e = evt({ organizationId: c.orgId, eventId: 'evt_retry' });
    c.subRepo.failNextUpsert = true;
    await expect(c.svc.applyWebhookEvent(e)).rejects.toThrow();
    // record-first：事件已记录，不 forget —— 防止 order 已写→seat 失败→forget→重试→撞 UNIQUE→死循环
    expect(await c.eventRepo.seen('stripe', 'evt_retry')).toBe(true);
    // 重试被跳过（record 返回 false = 已有人记过）
    await c.svc.applyWebhookEvent(e);
    // 订阅仍未激活（处理未完成，需人工排查）
  });

  it('eventId 按 provider 分别去重', async () => {
    const other = new StubAdapter();
    (other as any).name = 'lemonsqueezy';
    c.svc.registerProvider(other);

    await c.svc.applyWebhookEvent(evt({ organizationId: c.orgId, eventId: 'evt_1' }));
    const later = new Date(Date.now() + 60 * DAY);
    await c.svc.applyWebhookEvent(evt({
      organizationId: c.orgId, eventId: 'evt_1', provider: 'lemonsqueezy' as ProviderName, periodEnd: later,
    }));
    expect((await c.subRepo.findByOrganizationId(c.orgId))!.periodEndTime!.getTime()).toBe(later.getTime());
  });

  it('缺少 eventId 时按事件内容去重', async () => {
    const base = evt({ organizationId: c.orgId });
    delete (base as any).eventId;
    await c.svc.applyWebhookEvent(base);
    const first = await c.subRepo.findByOrganizationId(c.orgId);
    await c.svc.applyWebhookEvent({ ...base });
    expect((await c.subRepo.findByOrganizationId(c.orgId))!.updateTime.getTime())
      .toBe(first!.updateTime.getTime());
  });

  it('缺少 eventId 且内容不同 → 各自生效', async () => {
    const first = evt({ organizationId: c.orgId });
    delete (first as any).eventId;
    await c.svc.applyWebhookEvent(first);

    const later = new Date(Date.now() + 60 * DAY);
    const second = evt({ organizationId: c.orgId, periodEnd: later });
    delete (second as any).eventId;
    await c.svc.applyWebhookEvent(second);

    expect((await c.subRepo.findByOrganizationId(c.orgId))!.periodEndTime!.getTime()).toBe(later.getTime());
  });
});

describe('handleWebhook 端到端（含幂等与校验）', () => {
  it('合法事件生效并记录', async () => {
    c.adapter.next = evt({ organizationId: c.orgId, eventId: 'evt_e2e' });
    await c.svc.handleWebhook('stripe' as ProviderName, Buffer.from('{}'), 'sig');
    const sub = (await c.subRepo.findByOrganizationId(c.orgId))!;
    expect(sub.planId).toBe((await c.planRepo.findByCode('pro'))!.id);
    expect(await c.eventRepo.seen('stripe', 'evt_e2e')).toBe(true);
  });

  it('重复投递返回成功但不重复生效', async () => {
    c.adapter.next = evt({ organizationId: c.orgId, eventId: 'evt_dup' });
    await c.svc.handleWebhook('stripe' as ProviderName, Buffer.from('{}'), 'sig');
    const first = (await c.subRepo.findByOrganizationId(c.orgId))!.periodEndTime!.getTime();

    c.adapter.next = evt({
      organizationId: c.orgId, eventId: 'evt_dup', periodEnd: new Date(Date.now() + 999 * DAY),
    });
    await expect(c.svc.handleWebhook('stripe' as ProviderName, Buffer.from('{}'), 'sig'))
      .resolves.toBeUndefined();
    expect((await c.subRepo.findByOrganizationId(c.orgId))!.periodEndTime!.getTime()).toBe(first);
  });
});