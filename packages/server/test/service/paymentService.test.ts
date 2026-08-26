import { describe, it, expect } from 'vitest';
import { PaymentService } from '../../src/service/paymentService.js';
import { ManualPaymentAdapter } from '../../src/adapter/manualPaymentAdapter.js';
import type {
  PaymentProvider,
  PaymentPeriod,
  WebhookEvent,
} from '../../src/adapter/paymentProvider.js';
import type { PlanCode, PaymentProvider as ProviderName } from '../../src/domain/enums.js';
import {
  FakePlanRepo, FakeSubscriptionRepo, FakeOrganizationRepo, FakeOrderRepo, FakeSeatRepo, FakeWebhookEventRepo, FakeMembershipRepo, makePlan,
} from '../helpers/fakeRepos.js';

const DAY = 86400000;

/** 可观测的假支付商：记录调用并允许注入 webhook 结果 */
class StubProvider implements PaymentProvider {
  readonly createCalls: Array<{ organizationId: number; planCode: PlanCode; period: PaymentPeriod }> = [];
  readonly webhookCalls: Array<{ payload: string; signature?: string }> = [];

  constructor(
    readonly name: ProviderName,
    private readonly event?: WebhookEvent,
  ) {}

  async createSubscription(organizationId: number, planCode: PlanCode, period: PaymentPeriod) {
    this.createCalls.push({ organizationId, planCode, period });
    return {
      externalId: `${this.name}-${organizationId}-${period}`,
      periodEnd: new Date(Date.now() + (period === 'year' ? 365 : 30) * DAY),
    };
  }

  async cancelSubscription(): Promise<void> {}

  async handleWebhook(payload: Buffer, signature?: string): Promise<WebhookEvent> {
    this.webhookCalls.push({ payload: payload.toString('utf8'), signature });
    if (!this.event) throw new Error('signature verification failed');
    return this.event;
  }
}

async function setup() {
  const planRepo = new FakePlanRepo([makePlan('free'), makePlan('pro'), makePlan('team')]);
  const subRepo = new FakeSubscriptionRepo();
  const orgRepo = new FakeOrganizationRepo();
  const orderRepo = new FakeOrderRepo();
  const seatRepo = new FakeSeatRepo();
  const eventRepo = new FakeWebhookEventRepo();
  const membershipRepo = new FakeMembershipRepo();
  const service = new PaymentService(subRepo, orgRepo, planRepo, orderRepo, seatRepo, eventRepo, membershipRepo);
  const org = await orgRepo.create({ name: 'Acme', type: 'team', ownerUserId: 1 });
  return { service, subRepo, orgRepo, planRepo, orderRepo, seatRepo, eventRepo, membershipRepo, org };
}

function event(over: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    type: 'subscription_activated',
    organizationId: 1,
    planCode: 'pro',
    seatDelta: 0,
    periodEnd: new Date(Date.now() + 30 * DAY),
    externalId: 'ext-1',
    provider: 'stripe',
    ...over,
  };
}

/** 取 pro 套餐 id（setup 中 free=1, pro=2, team=3） */
async function proId(c: Awaited<ReturnType<typeof setup>>): Promise<number> {
  return (await c.planRepo.findByCode('pro'))!.id;
}

describe('PaymentService.renew', () => {
  it('rejects an unregistered provider before touching the repos', async () => {
    const { service, subRepo, org } = await setup();
    await expect(service.renew(org.id, 'pro', 'month', 'stripe')).rejects.toThrow(
      'unknown payment provider: stripe',
    );
    expect(subRepo.subs.size).toBe(0);
  });

  it('defaults to the manual provider', async () => {
    const c = await setup();
    c.service.registerProvider(new ManualPaymentAdapter());

    const sub = await c.service.renew(c.org.id, 'pro', 'month');

    expect(sub.provider).toBe('manual');
    expect(sub.status).toBe('active');
    expect(sub.planId).toBe(await proId(c));
    expect(sub.externalId).toMatch(/^manual-\d+-\d+$/);
    expect(c.subRepo.subs.size).toBe(1);
  });

  it('passes the period through to the adapter and reflects it in periodEndTime', async () => {
    const { service, org } = await setup();
    const stub = new StubProvider('stripe');
    service.registerProvider(stub);

    const sub = await service.renew(org.id, 'team', 'year', 'stripe');

    expect(stub.createCalls).toEqual([{ organizationId: org.id, planCode: 'team', period: 'year' }]);
    const days = (sub.periodEndTime!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(364);
    expect(sub.externalId).toBe(`stripe-${org.id}-year`);
  });

  it('updates the existing row instead of inserting a second one', async () => {
    const c = await setup();
    c.service.registerProvider(new ManualPaymentAdapter());

    const first = await c.service.renew(c.org.id, 'pro', 'month');
    const second = await c.service.renew(c.org.id, 'team', 'year');

    expect(second.id).toBe(first.id);
    expect(c.subRepo.subs.size).toBe(1);
    expect(second.planId).toBe((await c.planRepo.findByCode('team'))!.id);
  });

  it('registerProvider replaces a provider registered under the same name', async () => {
    const { service, org } = await setup();
    const first = new StubProvider('stripe');
    const second = new StubProvider('stripe');
    service.registerProvider(first);
    service.registerProvider(second);

    await service.renew(org.id, 'pro', 'month', 'stripe');

    expect(first.createCalls).toHaveLength(0);
    expect(second.createCalls).toHaveLength(1);
  });
});

describe('PaymentService.handleWebhook', () => {
  it('rejects an unregistered provider', async () => {
    const { service } = await setup();
    await expect(service.handleWebhook('stripe', Buffer.from('{}'))).rejects.toThrow(
      'unknown payment provider: stripe',
    );
  });

  it('forwards the raw payload and signature to the adapter', async () => {
    const { service, org } = await setup();
    const stub = new StubProvider('stripe', event({ organizationId: org.id }));
    service.registerProvider(stub);

    await service.handleWebhook('stripe', Buffer.from('{"raw":true}'), 'sig-abc');

    expect(stub.webhookCalls).toEqual([{ payload: '{"raw":true}', signature: 'sig-abc' }]);
  });

  it('propagates an adapter verification failure and applies nothing', async () => {
    const { service, subRepo } = await setup();
    service.registerProvider(new StubProvider('stripe'));

    await expect(service.handleWebhook('stripe', Buffer.from('{}'), 'bad')).rejects.toThrow(
      'signature verification failed',
    );
    expect(subRepo.subs.size).toBe(0);
  });

  it('manual adapter has no webhook', async () => {
    const { service } = await setup();
    service.registerProvider(new ManualPaymentAdapter());
    await expect(service.handleWebhook('manual', Buffer.from('{}'))).rejects.toThrow(
      'manual provider has no webhook',
    );
  });
});

describe('PaymentService.applyWebhookEvent', () => {
  it('activates a subscription and records an order', async () => {
    const c = await setup();
    const { subRepo, orderRepo, org } = c;
    const periodEnd = new Date(Date.now() + 30 * DAY);
    const pro = await proId(c);

    await c.service.applyWebhookEvent(event({ organizationId: org.id, periodEnd }));

    const sub = (await subRepo.findByOrganizationId(org.id))!;
    expect(sub.status).toBe('active');
    expect(sub.planId).toBe(pro);
    expect(sub.provider).toBe('stripe');
    expect(sub.externalId).toBe('ext-1');
    expect(sub.periodEndTime).toEqual(periodEnd);
    expect(orderRepo.orders.size).toBe(1);
  });

  it('is idempotent for a repeated renewal event', async () => {
    const { service, subRepo, org } = await setup();
    const evt = event({ type: 'subscription_renewed', organizationId: org.id });

    await service.applyWebhookEvent(evt);
    await service.applyWebhookEvent(evt);

    expect(subRepo.subs.size).toBe(1);
    expect((await subRepo.findByOrganizationId(org.id))!.status).toBe('active');
  });

  it('extends periodEndTime on renewal without creating a new row', async () => {
    const { service, subRepo, org } = await setup();
    const near = new Date(Date.now() + DAY);
    const far = new Date(Date.now() + 31 * DAY);

    await service.applyWebhookEvent(event({ organizationId: org.id, periodEnd: near }));
    const before = (await subRepo.findByOrganizationId(org.id))!.id;
    await service.applyWebhookEvent(event({ type: 'subscription_renewed', organizationId: org.id, periodEnd: far }));

    const sub = (await subRepo.findByOrganizationId(org.id))!;
    expect(sub.id).toBe(before);
    expect(sub.periodEndTime).toEqual(far);
  });

  it('cancels: marks the row canceled, stamps cancelTime, keeps periodEndTime', async () => {
    const { service, subRepo, org } = await setup();
    const periodEnd = new Date(Date.now() + 30 * DAY);
    await service.applyWebhookEvent(event({ organizationId: org.id, periodEnd }));

    await service.applyWebhookEvent(event({ type: 'subscription_canceled', organizationId: org.id }));

    const sub = (await subRepo.findByOrganizationId(org.id))!;
    expect(sub.status).toBe('canceled');
    expect(sub.cancelTime).toBeInstanceOf(Date);
    expect(sub.periodEndTime).toEqual(periodEnd);
  });

  it('expires: marks the row expired and leaves cancelTime unset', async () => {
    const { service, subRepo, org } = await setup();
    await service.applyWebhookEvent(event({ organizationId: org.id }));

    await service.applyWebhookEvent(event({ type: 'subscription_expired', organizationId: org.id }));

    const sub = (await subRepo.findByOrganizationId(org.id))!;
    expect(sub.status).toBe('expired');
    expect(sub.cancelTime).toBeUndefined();
  });

  it('seat_delta 正数创建等量席位，负数撤销', async () => {
    const c = await setup();
    await c.service.applyWebhookEvent(event({ organizationId: c.org.id, seatDelta: 3 }));
    expect(await c.seatRepo.countActiveByOrganization(c.org.id)).toBe(3);

    await c.service.applyWebhookEvent(event({ type: 'subscription_renewed', organizationId: c.org.id, externalId: 'ext-2', seatDelta: -1 }));
    expect(await c.seatRepo.countActiveByOrganization(c.org.id)).toBe(2);
  });

  it('撤席不击穿活跃成员数 ≤ 席位数约束', async () => {
    const c = await setup();
    // 3 席位 + 3 成员（含 owner），席位恰好被占满
    await c.service.applyWebhookEvent(event({ organizationId: c.org.id, seatDelta: 3 }));
    const orgId = c.org.id;
    await c.membershipRepo.create({ organizationId: orgId, userId: 1, role: 'admin' });
    await c.membershipRepo.create({ organizationId: orgId, userId: 2, role: 'member' });
    await c.membershipRepo.create({ organizationId: orgId, userId: 3, role: 'member' });
    expect(await c.membershipRepo.countActiveByOrganization(orgId)).toBe(3);
    expect(await c.seatRepo.countActiveByOrganization(orgId)).toBe(3);

    // 试图撤 2 席：activeSeats-activeMembers=0，全部拒绝
    await c.service.applyWebhookEvent(event({ type: 'subscription_renewed', organizationId: orgId, externalId: 'ext-cap', seatDelta: -2 }));
    expect(await c.seatRepo.countActiveByOrganization(orgId)).toBe(3);

    // 多 1 席时最多撤到成员数
    await c.service.applyWebhookEvent(event({ type: 'subscription_renewed', organizationId: orgId, externalId: 'ext-add', seatDelta: 2 }));
    expect(await c.seatRepo.countActiveByOrganization(orgId)).toBe(5);
    await c.service.applyWebhookEvent(event({ type: 'subscription_renewed', organizationId: orgId, externalId: 'ext-cap2', seatDelta: -3 }));
    // activeSeats(5)-activeMembers(3)=2，只能撤 2
    expect(await c.seatRepo.countActiveByOrganization(orgId)).toBe(3);
  });
});