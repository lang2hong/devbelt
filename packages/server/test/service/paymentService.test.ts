import { describe, it, expect } from 'vitest';
import { PaymentService } from '../../src/service/paymentService.js';
import { ManualPaymentAdapter } from '../../src/adapter/manualPaymentAdapter.js';
import type {
  PaymentProvider,
  PaymentPeriod,
  WebhookEvent,
} from '../../src/adapter/paymentProvider.js';
import type { PlanCode, PaymentProvider as ProviderName } from '../../src/domain/enums.js';
import { FakeSubscriptionRepo, FakeUserRepo } from '../helpers/fakeRepos.js';

const DAY = 86400000;

/** 可观测的假支付商：记录调用并允许注入 webhook 结果 */
class StubProvider implements PaymentProvider {
  readonly createCalls: Array<{ userId: number; planCode: PlanCode; period: PaymentPeriod }> = [];
  readonly webhookCalls: Array<{ payload: string; signature?: string }> = [];

  constructor(
    readonly name: ProviderName,
    private readonly event?: WebhookEvent,
  ) {}

  async createSubscription(userId: number, planCode: PlanCode, period: PaymentPeriod) {
    this.createCalls.push({ userId, planCode, period });
    return {
      externalId: `${this.name}-${userId}-${period}`,
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
  const subRepo = new FakeSubscriptionRepo();
  const userRepo = new FakeUserRepo();
  const service = new PaymentService(subRepo, userRepo);
  const user = await userRepo.create('a@example.com', 'scrypt$x$y', 'user', 'free');
  return { service, subRepo, userRepo, user };
}

function event(over: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    type: 'subscription_activated',
    userId: 1,
    planCode: 'pro',
    periodEnd: new Date(Date.now() + 30 * DAY),
    externalId: 'ext-1',
    provider: 'stripe',
    ...over,
  };
}

describe('PaymentService.renew', () => {
  it('rejects an unregistered provider before touching the repos', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await expect(service.renew(user.id, 'pro', 'month', 'stripe')).rejects.toThrow(
      'payment provider not registered: stripe',
    );
    expect(subRepo.subs.size).toBe(0);
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });

  it('defaults to the manual provider', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    service.registerProvider(new ManualPaymentAdapter());

    const sub = await service.renew(user.id, 'pro', 'month');

    expect(sub.provider).toBe('manual');
    expect(sub.status).toBe('active');
    expect(sub.planCode).toBe('pro');
    expect(sub.externalId).toMatch(/^manual-1-\d+$/);
    expect((await userRepo.findById(user.id))!.planCode).toBe('pro');
    expect(subRepo.subs.size).toBe(1);
  });

  it('passes the period through to the adapter and reflects it in periodEndTime', async () => {
    const { service, user } = await setup();
    const stub = new StubProvider('stripe');
    service.registerProvider(stub);

    const sub = await service.renew(user.id, 'team', 'year', 'stripe');

    expect(stub.createCalls).toEqual([{ userId: user.id, planCode: 'team', period: 'year' }]);
    const days = (sub.periodEndTime.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(364);
    expect(sub.externalId).toBe('stripe-1-year');
  });

  it('updates the existing row instead of inserting a second one', async () => {
    const { service, subRepo, user } = await setup();
    service.registerProvider(new ManualPaymentAdapter());

    const first = await service.renew(user.id, 'pro', 'month');
    const second = await service.renew(user.id, 'team', 'year');

    expect(second.id).toBe(first.id);
    expect(subRepo.subs.size).toBe(1);
    expect(second.planCode).toBe('team');
  });

  it('registerProvider replaces a provider registered under the same name', async () => {
    const { service, user } = await setup();
    const first = new StubProvider('stripe');
    const second = new StubProvider('stripe');
    service.registerProvider(first);
    service.registerProvider(second);

    await service.renew(user.id, 'pro', 'month', 'stripe');

    expect(first.createCalls).toHaveLength(0);
    expect(second.createCalls).toHaveLength(1);
  });
});

describe('PaymentService.handleWebhook', () => {
  it('rejects an unregistered provider', async () => {
    const { service } = await setup();
    await expect(service.handleWebhook('stripe', Buffer.from('{}'))).rejects.toThrow(
      'payment provider not registered: stripe',
    );
  });

  it('forwards the raw payload and signature to the adapter', async () => {
    const { service, user } = await setup();
    const stub = new StubProvider('stripe', event({ userId: user.id }));
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
  it('activates a subscription and upgrades the user plan', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    const periodEnd = new Date(Date.now() + 30 * DAY);

    await service.applyWebhookEvent(event({ userId: user.id, periodEnd }));

    const sub = (await subRepo.findByUserId(user.id))!;
    expect(sub.status).toBe('active');
    expect(sub.planCode).toBe('pro');
    expect(sub.provider).toBe('stripe');
    expect(sub.externalId).toBe('ext-1');
    expect(sub.periodEndTime).toEqual(periodEnd);
    expect((await userRepo.findById(user.id))!.planCode).toBe('pro');
  });

  it('is idempotent for a repeated renewal event', async () => {
    const { service, subRepo, user } = await setup();
    const evt = event({ type: 'subscription_renewed', userId: user.id });

    await service.applyWebhookEvent(evt);
    await service.applyWebhookEvent(evt);

    expect(subRepo.subs.size).toBe(1);
    expect((await subRepo.findByUserId(user.id))!.status).toBe('active');
  });

  it('extends periodEndTime on renewal without creating a new row', async () => {
    const { service, subRepo, user } = await setup();
    const near = new Date(Date.now() + DAY);
    const far = new Date(Date.now() + 31 * DAY);

    await service.applyWebhookEvent(event({ userId: user.id, periodEnd: near }));
    const before = (await subRepo.findByUserId(user.id))!.id;
    await service.applyWebhookEvent(event({ type: 'subscription_renewed', userId: user.id, periodEnd: far }));

    const sub = (await subRepo.findByUserId(user.id))!;
    expect(sub.id).toBe(before);
    expect(sub.periodEndTime).toEqual(far);
  });

  it('cancels: marks the row canceled, stamps cancelTime, keeps periodEndTime, drops user to free', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    const periodEnd = new Date(Date.now() + 30 * DAY);
    await service.applyWebhookEvent(event({ userId: user.id, periodEnd }));

    await service.applyWebhookEvent(event({ type: 'subscription_canceled', userId: user.id }));

    const sub = (await subRepo.findByUserId(user.id))!;
    expect(sub.status).toBe('canceled');
    expect(sub.cancelTime).toBeInstanceOf(Date);
    expect(sub.periodEndTime).toEqual(periodEnd);
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });

  it('expires: marks the row expired and leaves cancelTime unset', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await service.applyWebhookEvent(event({ userId: user.id }));

    await service.applyWebhookEvent(event({ type: 'subscription_expired', userId: user.id }));

    const sub = (await subRepo.findByUserId(user.id))!;
    expect(sub.status).toBe('expired');
    expect(sub.cancelTime).toBeUndefined();
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });

  it('still downgrades the user when no subscription row exists', async () => {
    const { service, subRepo, userRepo, user } = await setup();
    await userRepo.updatePlan(user.id, 'pro');

    await service.applyWebhookEvent(event({ type: 'subscription_expired', userId: user.id }));

    expect(subRepo.subs.size).toBe(0);
    expect((await userRepo.findById(user.id))!.planCode).toBe('free');
  });
});
