import { describe, it, expect } from 'vitest';
import { OrderService } from '../../src/modules/billing/service/paymentService.js';
import type {
  IOrderRepo,
  IPaymentRepo,
  IPlanRepo,
  IPersonalSubscriptionRepo,
} from '../../src/repository/interfaces.js';
import type { Order, Payment, Plan, PersonalSubscription } from '../../src/domain/entities.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { MemoryPaymentGateway, signMemoryCallback } from '../../src/modules/billing/service/paymentChannel.js';
import type { PaymentGateway, PaymentCallback } from '../../src/modules/billing/service/paymentChannel.js';
import {
  PaymentSignatureInvalidError,
  UnknownPlanError,
} from '../../src/domain/errors.js';
import { deriveEntitlement } from '../../src/modules/billing/service/entitlement.js';

const PLAN: Plan = {
  id: 2,
  code: 'pro',
  kind: 'personal',
  name: 'Pro',
  priceCents: 9900,
  billingUnit: 'month',
  sortOrder: 0,
  status: 'active',
  version: 1,
  features: {
    allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite', 'redis'],
    maxDevices: 0,
    maxConnectionMetas: 5000,
    syncStorageBytes: 268435456,
    maxSavedConnections: 100,
    allowConnectionImport: true,
  },
  createTime: new Date(),
  updateTime: new Date(),
};

const FREE: Plan = {
  id: 1, code: 'free', kind: 'personal', name: 'Free', priceCents: 0, billingUnit: 'month', sortOrder: 0, status: 'active', version: 1,
  features: { allowedDatabaseTypes: ['mysql', 'sqlite', 'redis'], maxDevices: 0, maxConnectionMetas: 500, syncStorageBytes: 33554432, maxSavedConnections: 10, allowConnectionImport: false },
  createTime: new Date(), updateTime: new Date(),
};

class FakeOrderRepo implements IOrderRepo {
  readonly store = new Map<string, Order>();
  private seq = 0;
  async create(input: { orderNo: string; userId: number; planCode: string; planVersion: number; amountCents: number; channel: Order['channel']; expiresTime: Date }): Promise<Order> {
    const o: Order = { id: ++this.seq, orderNo: input.orderNo, userId: input.userId, planCode: input.planCode, planVersion: input.planVersion, amountCents: input.amountCents, channel: input.channel, status: 'pending', channelTradeNo: null, paidTime: null, expiresTime: input.expiresTime, createTime: new Date(), updateTime: new Date() };
    this.store.set(input.orderNo, o);
    return o;
  }
  async findByOrderNo(orderNo: string): Promise<Order | undefined> { return this.store.get(orderNo); }
  async findByOrderNoForUpdate(_exec: Queryable, orderNo: string): Promise<Order | undefined> { return this.store.get(orderNo); }
  async findByIdForUpdate(_exec: Queryable, id: number): Promise<Order | undefined> { return [...this.store.values()].find((o) => o.id === id); }
  async advance(_exec: Queryable, input: { id: number; expectedStatus: Order['status']; status: Order['status']; channelTradeNo: string | null; paidTime: Date | null }): Promise<boolean> {
    for (const o of this.store.values()) {
      if (o.id === input.id && o.status === input.expectedStatus) {
        o.status = input.status;
        if (input.channelTradeNo) o.channelTradeNo = input.channelTradeNo;
        if (input.paidTime) o.paidTime = input.paidTime;
        return true;
      }
    }
    return false;
  }
  async listByUser(userId: number, _cursor: number | undefined, limit: number): Promise<Order[]> {
    return [...this.store.values()].filter((o) => o.userId === userId).slice(0, limit);
  }
  async findPendingByUserAndPlan(userId: number, planCode: string, channel: Order['channel']): Promise<Order | undefined> {
    return [...this.store.values()].find((o) => o.userId === userId && o.planCode === planCode && o.channel === channel && o.status === 'pending');
  }

  async expirePending(_now: Date, _limit: number): Promise<number> {
    return 0;
  }
  async listAll(): Promise<Order[]> {
    return [...this.store.values()];
  }
}

class FakePaymentRepo implements IPaymentRepo {
  readonly store: Payment[] = [];
  async create(_exec: Queryable, input: { orderId: number; channel: Payment['channel']; channelTradeNo: string; amountCents: number; notifySummary: string | null; result: Payment['result'] }): Promise<Payment> {
    const p: Payment = { id: this.store.length + 1, orderId: input.orderId, channel: input.channel, channelTradeNo: input.channelTradeNo, amountCents: input.amountCents, notifySummary: input.notifySummary, result: input.result, createTime: new Date() };
    this.store.push(p);
    return p;
  }
  async findByChannelTradeNo(_exec: Queryable, channel: Payment['channel'], channelTradeNo: string): Promise<Payment | undefined> {
    return this.store.find((p) => p.channel === channel && p.channelTradeNo === channelTradeNo);
  }
}

class FakePlanRepo implements IPlanRepo {
  // 每个实例用独立副本，避免某个用例改 status 污染其它用例。
  private readonly plans: Plan[] = [
    { ...FREE, features: { ...FREE.features } },
    { ...PLAN, features: { ...PLAN.features } },
  ];
  async findByCode(code: string): Promise<Plan | undefined> { return this.plans.find((p) => p.code === code); }
  async findById(id: number): Promise<Plan | undefined> { return this.plans.find((p) => p.id === id); }
  async findByCodeInTx(_exec: Queryable, code: string): Promise<Plan | undefined> { return this.findByCode(code); }
  async findByIdInTx(_exec: Queryable, id: number): Promise<Plan | undefined> { return this.findById(id); }
  async listActive(): Promise<Plan[]> { return this.plans.filter((p) => p.status === 'active'); }
  async listAll(): Promise<Plan[]> { return [...this.plans]; }
  async saveInTx(): Promise<boolean> { return true; }
  invalidate(): void {}
}

class FakeSubsRepo implements IPersonalSubscriptionRepo {
  subs = new Map<number, PersonalSubscription>();
  async findByUserId(userId: number): Promise<PersonalSubscription | undefined> { return [...this.subs.values()].find((s) => s.userId === userId); }
  async findByUserIdInTx(_e: Queryable, userId: number): Promise<PersonalSubscription | undefined> { return this.findByUserId(userId); }
  async findByUserIdForUpdate(_e: Queryable, userId: number): Promise<PersonalSubscription | undefined> { return this.findByUserId(userId); }
  async create(input: { userId: number; planId: number; status: PersonalSubscription['status']; periodStartTime: Date; periodEndTime: Date | null }): Promise<PersonalSubscription> {
    const s: PersonalSubscription = { id: this.subs.size + 1, userId: input.userId, planId: input.planId, status: input.status, periodStartTime: input.periodStartTime, periodEndTime: input.periodEndTime, version: 0, createTime: new Date(), updateTime: new Date() };
    this.subs.set(s.id, s);
    return s;
  }
  async update(_e: Queryable, input: { id: number; planId: number; status: PersonalSubscription['status']; periodEndTime: Date | null; expectedVersion: number }): Promise<boolean> {
    const s = this.subs.get(input.id);
    if (!s || s.version !== input.expectedVersion) return false;
    s.planId = input.planId;
    s.status = input.status;
    s.periodEndTime = input.periodEndTime;
    s.version += 1;
    return true;
  }
}

function makeService(nonceRepo?: { insertIfAbsent(exec: Queryable, channel: string, nonceHash: string, expiresTime: Date): Promise<boolean>; purgeExpired(exec: Queryable): Promise<number> }) {
  const orderRepo = new FakeOrderRepo();
  const paymentRepo = new FakePaymentRepo();
  const planRepo = new FakePlanRepo();
  const subsRepo = new FakeSubsRepo();
  const audit = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any);
  const svc = new OrderService({
    orderRepo,
    paymentRepo,
    planRepo,
    personalSubscriptionRepo: subsRepo,
    auditWriter: audit,
    runner: async (fn) => fn({} as Queryable),
    gatewayFor: (channel) => new MemoryPaymentGateway(channel),
    nonceRepo,
  });
  return { svc, orderRepo, paymentRepo, subsRepo, planRepo };
}

const SUCCESS_CALLBACK = (orderNo: string, channelTradeNo: string, amountCents: number) => {
  const raw = Buffer.from(JSON.stringify({ orderNo, channelTradeNo, amountCents, status: 'success' }));
  return { raw, headers: { 'x-payment-signature': signMemoryCallback(raw) } as Record<string, string> };
};

describe('OrderService.createOrder', () => {
  it('creates a pending order priced server-side (integer cents)', async () => {
    const { svc, orderRepo } = makeService();
    const r = await svc.createOrder(1, 'pro', 'wechat');
    expect(r.amountCents).toBe(9900);
    expect(r.orderNo.length).toBeLessThanOrEqual(32); // 微信 out_trade_no 上限 32 字符
    const order = await orderRepo.findByOrderNo(r.orderNo);
    expect(order).toBeDefined();
    expect(order!.status).toBe('pending');
    expect(order!.channel).toBe('wechat');
    expect(r.payParams.codeUrl).toBeTruthy();
    expect(r.payParams).toEqual({ codeUrl: expect.any(String) });
  });

  it('creates a fresh order instead of reusing a nearly-expired pending order', async () => {
    const { svc, orderRepo } = makeService();
    const first = await svc.createOrder(1, 'pro', 'wechat');
    // 伪造既有 pending 临近过期（< 1m）：渠道无法表示不越界的外部窗口，应改建新单。
    const o = await orderRepo.findByOrderNo(first.orderNo);
    o!.expiresTime = new Date(Date.now() + 30 * 1000);

    const second = await svc.createOrder(1, 'pro', 'wechat');
    expect(second.orderNo).not.toBe(first.orderNo);
    expect([...orderRepo.store.values()].filter((x) => x.userId === 1 && x.status === 'pending')).toHaveLength(2);
  });

  it('re-pre-pays the same out_trade_no for a reused pending order (channel idempotency stub)', async () => {
    const orderRepo = new FakeOrderRepo();
    const paymentRepo = new FakePaymentRepo();
    const planRepo = new FakePlanRepo();
    const subsRepo = new FakeSubsRepo();
    const prepayOrderNos: string[] = [];
    const base = new MemoryPaymentGateway('wechat');
    const capturing: PaymentGateway = {
      channel: 'wechat',
      async createPayment(input: { orderNo: string }) {
        prepayOrderNos.push(input.orderNo);
        return {};
      },
      verifyCallback: base.verifyCallback.bind(base),
      parseCallback: base.parseCallback.bind(base),
    };
    const svc = new OrderService({
      orderRepo,
      paymentRepo,
      planRepo,
      personalSubscriptionRepo: subsRepo,
      auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any),
      runner: async (fn) => fn({} as Queryable),
      gatewayFor: () => capturing,
    });

    const first = await svc.createOrder(1, 'pro', 'wechat');
    const second = await svc.createOrder(1, 'pro', 'wechat');
    expect(second.orderNo).toBe(first.orderNo);
    // 复用 pending 时渠道 prepay 仍用同一 out_trade_no（依赖渠道幂等，而非新建号）。
    expect(prepayOrderNos).toEqual([first.orderNo, first.orderNo]);
  });
});

describe('OrderService.createOrder plan guards', () => {
  it('rejects free (price 0) with UnknownPlanError', async () => {
    const { svc } = makeService();
    await expect(svc.createOrder(1, 'free', 'wechat')).rejects.toBeInstanceOf(UnknownPlanError);
  });
  it('rejects an unknown plan code', async () => {
    const { svc } = makeService();
    await expect(svc.createOrder(1, 'nope', 'wechat')).rejects.toBeInstanceOf(UnknownPlanError);
  });
  it('rejects an archived plan', async () => {
    const { svc, planRepo } = makeService();
    (await planRepo.findByCode('pro'))!.status = 'archived';
    await expect(svc.createOrder(1, 'pro', 'wechat')).rejects.toBeInstanceOf(UnknownPlanError);
  });
});

describe('OrderService.handleCallback', () => {
  it('fulfills: pending → paid → fulfilled and rewrites the subscription', async () => {
    const { svc, orderRepo, subsRepo, planRepo } = makeService();
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');

    const cb = SUCCESS_CALLBACK(orderNo, 'wx-1', 9900);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);

    expect(outcome.kind).toBe('fulfilled');
    const order = await orderRepo.findByOrderNo(orderNo);
    expect(order!.status).toBe('fulfilled');
    const sub = await subsRepo.findByUserId(1);
    expect(sub!.planId).toBe(2);
    // 行为断言：履约后权益由「订阅指向的 pro plan」派生，而非测试夹具常量。
    const derived = deriveEntitlement(sub, await planRepo.findByCode('pro'), await planRepo.findByCode('free'));
    expect(derived.maxConnectionMetas).toBe(5000);
    expect(derived.maxDevices).toBe(0);
  });

  it('extends the existing periodEndTime instead of overwriting remaining time', async () => {
    const { svc, subsRepo } = makeService();
    const startTime = new Date(Date.now() - 5 * 24 * 3600 * 1000); // 5 天前开始
    const existingEnd = new Date(Date.now() + 20 * 24 * 3600 * 1000); // 20 天剩余
    await subsRepo.create({ userId: 1, planId: 2, status: 'active', periodStartTime: startTime, periodEndTime: existingEnd });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    const cb = SUCCESS_CALLBACK(orderNo, 'wx-1', 9900);
    await svc.handleCallback('wechat', cb.raw, cb.headers);

    const sub = await subsRepo.findByUserId(1);
    // 新的到期日 ≈ 既有到期日 + 30 天，而非 now + 30 天（不吞 20 天剩余）。
    const expected = existingEnd.getTime() + 30 * 24 * 3600 * 1000;
    expect(sub!.periodEndTime!.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(sub!.periodEndTime!.getTime()).toBeLessThanOrEqual(expected + 1000);
    // 叠加：周期起点保持原值，不因续费重置为 now。
    expect(sub!.periodStartTime.getTime()).toBe(startTime.getTime());
  });

  it('fulfills an alipay order via its own alipay callback (cross-channel isolation)', async () => {
    const { svc, orderRepo, subsRepo } = makeService();
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    await svc.createOrder(1, 'pro', 'wechat');
    const alipay = await svc.createOrder(1, 'pro', 'alipay');

    const cb = SUCCESS_CALLBACK(alipay.orderNo, 'ali-1', 9900);
    const outcome = await svc.handleCallback('alipay', cb.raw, cb.headers);

    expect(outcome.kind).toBe('fulfilled');
    const order = await orderRepo.findByOrderNo(alipay.orderNo);
    expect(order!.status).toBe('fulfilled');
    expect(order!.channel).toBe('alipay');
  });

  it('records (not fulfills) a callback arriving after the local order expiry', async () => {
    const { svc, orderRepo, subsRepo } = makeService();
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    // 伪造订单已过期。
    const order = await orderRepo.findByOrderNo(orderNo);
    order!.expiresTime = new Date(Date.now() - 1000);

    const cb = SUCCESS_CALLBACK(orderNo, 'wx-1', 9900);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);

    expect(outcome.kind).toBe('recorded');
    expect((await orderRepo.findByOrderNo(orderNo))!.status).toBe('pending');
    const sub = await subsRepo.findByUserId(1);
    expect(sub!.planId).toBe(1); // 权益未改（不履约）。
  });

  it('rejects a tampered signature before any side effect', async () => {
    const { svc, orderRepo } = makeService();
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    await expect(
      svc.handleCallback('wechat', SUCCESS_CALLBACK(orderNo, 'wx-1', 9900).raw, { 'x-payment-signature': 'bad' }),
    ).rejects.toBeInstanceOf(PaymentSignatureInvalidError);
    const order = await orderRepo.findByOrderNo(orderNo);
    expect(order!.status).toBe('pending');
  });

  it('rejects a callback whose body was altered after signing (signature binds raw bytes)', async () => {
    const { svc, orderRepo } = makeService();
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    const cb = SUCCESS_CALLBACK(orderNo, 'wx-1', 9900);
    const tampered = Buffer.from(cb.raw.toString('utf8').replace('9900', '9901'));
    await expect(
      svc.handleCallback('wechat', tampered, cb.headers),
    ).rejects.toBeInstanceOf(PaymentSignatureInvalidError);
    const order = await orderRepo.findByOrderNo(orderNo);
    expect(order!.status).toBe('pending');
  });

  it('rejects a mismatched amount', async () => {
    const { svc } = makeService();
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    const cb = SUCCESS_CALLBACK(orderNo, 'wx-1', 1);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(outcome).toEqual({ kind: 'rejected', code: 'PAYMENT_AMOUNT_MISMATCH' });
  });

  it('is idempotent for a duplicate channel_trade_no', async () => {
    const { svc, subsRepo } = makeService();
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    const cb = SUCCESS_CALLBACK(orderNo, 'wx-dup', 9900);
    await svc.handleCallback('wechat', cb.raw, cb.headers);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(outcome.kind).toBe('duplicate');
  });

  it('rejects a replayed wechat callback by persisted nonce (before business)', async () => {
    const seen = new Set<string>();
    const nonceRepo = {
      insertIfAbsent: async (_exec: Queryable, _channel: string, nonceHash: string) => {
        if (seen.has(nonceHash)) return false;
        seen.add(nonceHash);
        return true;
      },
      purgeExpired: async () => 0,
    };
    const { svc, subsRepo } = makeService(nonceRepo);
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    const cb = SUCCESS_CALLBACK(orderNo, 'wx-nonce', 9900);
    cb.headers['wechatpay-nonce'] = 'nonce-abc';

    const first = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(first.kind).toBe('fulfilled');
    const replay = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(replay.kind).toBe('duplicate');
  });

  it('rejected for an unknown orderNo', async () => {
    const { svc } = makeService();
    const cb = SUCCESS_CALLBACK('nope', 'wx-1', 9900);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(outcome).toEqual({ kind: 'rejected', code: 'ORDER_NOT_FOUND' });
  });

  it('reuses an existing pending order for the same user, plan and channel', async () => {
    const { svc, orderRepo } = makeService();
    const first = await svc.createOrder(1, 'pro', 'wechat');
    const second = await svc.createOrder(1, 'pro', 'wechat');
    expect(second.orderNo).toBe(first.orderNo);
    expect([...orderRepo.store.values()].filter((o) => o.userId === 1)).toHaveLength(1);
  });

  it('persists only the allowlisted summary to raw_notification, not the raw body', async () => {
    const orderRepo = new FakeOrderRepo();
    const paymentRepo = new FakePaymentRepo();
    const subsRepo = new FakeSubsRepo();
    const gateway: PaymentGateway = {
      channel: 'wechat',
      async createPayment() { return {}; },
      verifyCallback() { return true; },
      parseCallback(rawBody: Buffer): PaymentCallback {
        const d = JSON.parse(rawBody.toString('utf8')) as { orderNo: string; channelTradeNo: string; amountCents: number };
        return { orderNo: d.orderNo, channelTradeNo: d.channelTradeNo, amountCents: d.amountCents, status: 'success', summary: { out_trade_no: d.orderNo, transaction_id: d.channelTradeNo, total: String(d.amountCents) } };
      },
    };
    const svc = new OrderService({
      orderRepo, paymentRepo, planRepo: new FakePlanRepo(), personalSubscriptionRepo: subsRepo,
      auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any),
      runner: async (fn) => fn({} as Queryable),
      gatewayFor: () => gateway,
    });
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');

    // 原始 body 含未允许字段（payer.openid）；落库必须只留白名单摘要。
    const raw = Buffer.from(JSON.stringify({ orderNo, channelTradeNo: 'wx-1', amountCents: 9900, status: 'success', payer: { openid: 'OPENID_SECRET' } }));
    await svc.handleCallback('wechat', raw, {});

    const p = paymentRepo.store[0];
    expect(p).toBeDefined();
    expect(p!.notifySummary).toBe(JSON.stringify({ out_trade_no: orderNo, transaction_id: 'wx-1', total: '9900' }));
    expect(p!.notifySummary).not.toContain('OPENID_SECRET');
  });

  it('does NOT reuse a pending order across different channels, leaving the prior channel pending', async () => {
    const { svc, orderRepo } = makeService();
    const wechat = await svc.createOrder(1, 'pro', 'wechat');
    const alipay = await svc.createOrder(1, 'pro', 'alipay');
    expect(alipay.orderNo).not.toBe(wechat.orderNo);
    expect(alipay.channel).toBe('alipay');
    // 旧渠道保持 pending（自然过期），不本地宣告过期——用户可能已拿到旧渠道支付码。
    expect(await orderRepo.findByOrderNo(wechat.orderNo)).toMatchObject({ status: 'pending' });
    expect(await orderRepo.findByOrderNo(alipay.orderNo)).toMatchObject({ status: 'pending' });
  });

  it('fulfills a prior-channel callback after switching channels (no confirmed-but-unfulfilled)', async () => {
    const { svc, orderRepo, subsRepo } = makeService();
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    const wechat = await svc.createOrder(1, 'pro', 'wechat');
    // 用户切到支付宝，开了第二个订单。
    await svc.createOrder(1, 'pro', 'alipay');

    // 但用户在旧微信页完成了付款 → 必须正常履约，而非被丢弃。
    const cb = SUCCESS_CALLBACK(wechat.orderNo, 'wx-1', 9900);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(outcome.kind).toBe('fulfilled');
    expect((await orderRepo.findByOrderNo(wechat.orderNo))!.status).toBe('fulfilled');
  });

  it('passes the original raw bytes to signature verification', async () => {
    const orderRepo = new FakeOrderRepo();
    const paymentRepo = new FakePaymentRepo();
    const planRepo = new FakePlanRepo();
    const subsRepo = new FakeSubsRepo();
    let seenRawBody: Buffer | undefined;
    let seenParsed: PaymentCallback | undefined;
    const capturingGateway: PaymentGateway = {
      channel: 'wechat',
      async createPayment() {
        return {};
      },
      verifyCallback(rawBody: Buffer): boolean {
        seenRawBody = rawBody;
        return true;
      },
      parseCallback(rawBody: Buffer): PaymentCallback {
        const parsed = JSON.parse(rawBody.toString('utf8')) as PaymentCallback;
        seenParsed = parsed;
        return parsed;
      },
    };
    const svc = new OrderService({
      orderRepo,
      paymentRepo,
      planRepo,
      personalSubscriptionRepo: subsRepo,
      auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any),
      runner: async (fn) => fn({} as Queryable),
      gatewayFor: () => capturingGateway,
    });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    // 非 JSON.stringify 规范化格式：字段乱序 + 多余空白 + 条数重复，验证字节不被重编码。
    const raw = Buffer.from(`{  "amountCents": 9900,\n "status":"success",\n "channelTradeNo":"wx-raw","orderNo":"${orderNo}" }`);
    await svc.handleCallback('wechat', raw, {});
    expect(seenRawBody!.equals(raw)).toBe(true);
    expect(seenParsed!.orderNo).toBe(orderNo);
  });

  it('preserves multibyte UTF-8 bytes across chunk boundaries', async () => {
    const orderRepo = new FakeOrderRepo();
    const paymentRepo = new FakePaymentRepo();
    const planRepo = new FakePlanRepo();
    const subsRepo = new FakeSubsRepo();
    let seenRawBody: Buffer | undefined;
    const capturingGateway: PaymentGateway = {
      channel: 'wechat',
      async createPayment() {
        return {};
      },
      verifyCallback(rawBody: Buffer): boolean {
        seenRawBody = rawBody;
        return true;
      },
      parseCallback(rawBody: Buffer): PaymentCallback {
        return JSON.parse(rawBody.toString('utf8')) as PaymentCallback;
      },
    };
    const svc = new OrderService({
      orderRepo,
      paymentRepo,
      planRepo,
      personalSubscriptionRepo: subsRepo,
      auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any),
      runner: async (fn) => fn({} as Queryable),
      gatewayFor: () => capturingGateway,
    });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });
    // 中文「支付成功」占 4 字节/字；在字符序列中间切开，模拟 stream chunk 边界。
    const full = Buffer.from(JSON.stringify({ orderNo, channelTradeNo: 'wx-mb', amountCents: 9900, status: 'success', note: '支付成功✅' }));
    const cut = Math.floor(full.length / 2);
    const chunk1 = full.subarray(0, cut);
    const chunk2 = full.subarray(cut);
    const reassembled = Buffer.concat([chunk1, chunk2]);
    await svc.handleCallback('wechat', reassembled, {});
    expect(seenRawBody!.equals(full)).toBe(true);
  });
});
describe('wechat nonce 与订单操作同事务（P2 回归保护）', () => {
  const order: Order = {
    id: 1, orderNo: 'o1', userId: 1, planCode: 'pro', planVersion: 1, amountCents: 9900, channel: 'wechat',
    status: 'pending', channelTradeNo: null, paidTime: null,
    expiresTime: new Date(Date.now() + 3_600_000), createTime: new Date(), updateTime: new Date(),
  };
  const sub: PersonalSubscription = {
    id: 1, userId: 1, planId: 2, status: 'active',
    periodStartTime: new Date(), periodEndTime: null, version: 0, createTime: new Date(), updateTime: new Date(),
  };

  function build(opts: { committed: Set<string>; failFirstAdvance?: boolean; execs: Queryable[] }) {
    let local = new Set<string>();
    let lastTx: Queryable | undefined;
    let advanceCalls = 0;
    const nonceRepo = {
      insertIfAbsent: async (exec: Queryable, _c: string, nonceHash: string) => {
        opts.execs.push(exec);
        if (opts.committed.has(nonceHash) || local.has(nonceHash)) return false;
        local.add(nonceHash);
        return true;
      },
      purgeExpired: async () => 0,
    };
    const orderRepo = {
      findByOrderNoForUpdate: async (exec: Queryable) => { opts.execs.push(exec); return order; },
      advance: async (exec: Queryable) => {
        opts.execs.push(exec);
        advanceCalls += 1;
        if (opts.failFirstAdvance && advanceCalls === 1) throw new Error('business failure');
        return true;
      },
    };
    const paymentRepo = {
      findByChannelTradeNo: async (exec: Queryable) => { opts.execs.push(exec); return undefined; },
      create: async (exec: Queryable) => { opts.execs.push(exec); return {}; },
    };
    const planRepo = { findByCodeInTx: async (exec: Queryable) => { opts.execs.push(exec); return PLAN; } };
    const subsRepo = {
      findByUserIdForUpdate: async (exec: Queryable) => { opts.execs.push(exec); return sub; },
      update: async (exec: Queryable) => { opts.execs.push(exec); return true; },
    };
    const audit = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any);
    const svc = new OrderService({
      orderRepo: orderRepo as any,
      paymentRepo: paymentRepo as any,
      planRepo: planRepo as any,
      personalSubscriptionRepo: subsRepo as any,
      auditWriter: audit,
      // 事务模型：fn 内写入 local；成功才提交到 committed，抛错即丢弃（回滚）。
      runner: async (fn) => {
        local = new Set<string>();
        lastTx = {} as Queryable;
        const r = await fn(lastTx);
        for (const h of local) opts.committed.add(h);
        return r;
      },
      gatewayFor: (c) => new MemoryPaymentGateway(c),
      nonceRepo,
    });
    return { svc, lastTx: () => lastTx };
  }

  it('insertIfAbsent 收到与订单锁/推进完全相同的 tx（回归：移出事务将失败）', async () => {
    const execs: Queryable[] = [];
    const { svc, lastTx } = build({ committed: new Set<string>(), execs });
    const cb = SUCCESS_CALLBACK('o1', 'wx-1', 9900);
    cb.headers['wechatpay-nonce'] = 'n1';
    const r = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(r.kind).toBe('fulfilled');
    const tx = lastTx();
    expect(execs.length).toBeGreaterThan(0);
    expect(execs.every((e) => e === tx)).toBe(true);
  });

  it('业务失败回滚后 nonce 不提交，渠道重试可成功处理（不误判重放）', async () => {
    const committed = new Set<string>();
    const { svc } = build({ committed, failFirstAdvance: true, execs: [] });
    const cb = SUCCESS_CALLBACK('o1', 'wx-1', 9900);
    cb.headers['wechatpay-nonce'] = 'n1';
    await expect(svc.handleCallback('wechat', cb.raw, cb.headers)).rejects.toThrow('business failure');
    expect(committed.has('n1')).toBe(false);
    const retry = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(retry.kind).toBe('fulfilled');
    expect(committed.size).toBe(1); // 重试成功后才提交
  });
});
