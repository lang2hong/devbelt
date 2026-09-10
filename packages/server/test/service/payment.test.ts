import { describe, it, expect } from 'vitest';
import { OrderService } from '../../src/service/paymentService.js';
import type {
  IOrderRepo,
  IPaymentRepo,
  IPersonalPlanRepo,
  IPersonalSubscriptionRepo,
} from '../../src/repository/interfaces.js';
import type { Order, Payment, PersonalPlan, PersonalSubscription } from '../../src/domain/entities.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { MemoryPaymentGateway, signMemoryCallback } from '../../src/service/paymentChannel.js';
import type { PaymentGateway, PaymentCallback } from '../../src/service/paymentChannel.js';
import {
  PaymentSignatureInvalidError,
} from '../../src/domain/errors.js';

const PLAN: PersonalPlan = {
  id: 2,
  code: 'pro',
  name: 'Pro',
  allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'],
  maxDevices: 0,
  maxConnectionMetas: 5000,
  syncStorageBytes: 268435456,
  maxSavedConnections: 100,
  allowConnectionImport: true,
  status: 'active',
  createTime: new Date(),
  updateTime: new Date(),
};

class FakeOrderRepo implements IOrderRepo {
  readonly store = new Map<string, Order>();
  private seq = 0;
  async create(input: { orderNo: string; userId: number; planCode: string; amountCents: number; channel: Order['channel']; expiresTime: Date }): Promise<Order> {
    const o: Order = { id: ++this.seq, orderNo: input.orderNo, userId: input.userId, planCode: input.planCode, amountCents: input.amountCents, channel: input.channel, status: 'pending', channelTradeNo: null, paidTime: null, expiresTime: input.expiresTime, createTime: new Date(), updateTime: new Date() };
    this.store.set(input.orderNo, o);
    return o;
  }
  async findByOrderNo(orderNo: string): Promise<Order | undefined> { return this.store.get(orderNo); }
  async findByOrderNoForUpdate(_exec: Queryable, orderNo: string): Promise<Order | undefined> { return this.store.get(orderNo); }
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
}

class FakePaymentRepo implements IPaymentRepo {
  readonly store: Payment[] = [];
  async create(_exec: Queryable, input: { orderId: number; channel: Payment['channel']; channelTradeNo: string; amountCents: number; rawNotification: string | null; signatureVerified: boolean; result: Payment['result'] }): Promise<Payment> {
    const p: Payment = { id: this.store.length + 1, orderId: input.orderId, channel: input.channel, channelTradeNo: input.channelTradeNo, amountCents: input.amountCents, rawNotification: input.rawNotification, signatureVerified: input.signatureVerified, result: input.result, createTime: new Date() };
    this.store.push(p);
    return p;
  }
  async findByChannelTradeNo(_exec: Queryable, channel: Payment['channel'], channelTradeNo: string): Promise<Payment | undefined> {
    return this.store.find((p) => p.channel === channel && p.channelTradeNo === channelTradeNo);
  }
}

class FakePlanRepo implements IPersonalPlanRepo {
  async findByCode(code: string): Promise<PersonalPlan | undefined> { return code === 'pro' ? PLAN : undefined; }
  async findById(id: number): Promise<PersonalPlan | undefined> { return id === 2 ? PLAN : undefined; }
  async findByCodeInTx(_exec: Queryable, code: string): Promise<PersonalPlan | undefined> { return code === 'pro' ? PLAN : undefined; }
}

class FakeSubsRepo implements IPersonalSubscriptionRepo {
  subs = new Map<number, PersonalSubscription>();
  async findByUserId(userId: number): Promise<PersonalSubscription | undefined> { return [...this.subs.values()].find((s) => s.userId === userId); }
  async findByUserIdInTx(_e: Queryable, userId: number): Promise<PersonalSubscription | undefined> { return this.findByUserId(userId); }
  async findByUserIdForUpdate(_e: Queryable, userId: number): Promise<PersonalSubscription | undefined> { return this.findByUserId(userId); }
  async create(input: { userId: number; planId: number; status: PersonalSubscription['status']; entitlementSnapshot: Record<string, unknown>; periodStartTime: Date; periodEndTime: Date | null }): Promise<PersonalSubscription> {
    const s: PersonalSubscription = { id: this.subs.size + 1, userId: input.userId, planId: input.planId, status: input.status, entitlementSnapshot: input.entitlementSnapshot, periodStartTime: input.periodStartTime, periodEndTime: input.periodEndTime, version: 0, createTime: new Date(), updateTime: new Date() };
    this.subs.set(s.id, s);
    return s;
  }
  async update(_e: Queryable, input: { id: number; planId: number; status: PersonalSubscription['status']; entitlementSnapshot: Record<string, unknown>; periodEndTime: Date | null; expectedVersion: number }): Promise<boolean> {
    const s = this.subs.get(input.id);
    if (!s || s.version !== input.expectedVersion) return false;
    s.planId = input.planId;
    s.status = input.status;
    s.entitlementSnapshot = input.entitlementSnapshot;
    s.periodEndTime = input.periodEndTime;
    s.version += 1;
    return true;
  }
}

function makeService() {
  const orderRepo = new FakeOrderRepo();
  const paymentRepo = new FakePaymentRepo();
  const planRepo = new FakePlanRepo();
  const subsRepo = new FakeSubsRepo();
  const audit = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any);
  const svc = new OrderService({
    orderRepo,
    paymentRepo,
    personalPlanRepo: planRepo,
    personalSubscriptionRepo: subsRepo,
    auditWriter: audit,
    runner: async (fn) => fn({} as Queryable),
    gatewayFor: (channel) => new MemoryPaymentGateway(channel),
  });
  return { svc, orderRepo, paymentRepo, subsRepo };
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
    const order = await orderRepo.findByOrderNo(r.orderNo);
    expect(order).toBeDefined();
    expect(order!.status).toBe('pending');
    expect(order!.channel).toBe('wechat');
    expect(r.payParams.orderNo).toBe(r.orderNo);
  });
});

describe('OrderService.handleCallback', () => {
  it('fulfills: pending → paid → fulfilled and rewrites the subscription', async () => {
    const { svc, orderRepo, subsRepo } = makeService();
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');

    const cb = SUCCESS_CALLBACK(orderNo, 'wx-1', 9900);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);

    expect(outcome.kind).toBe('fulfilled');
    const order = await orderRepo.findByOrderNo(orderNo);
    expect(order!.status).toBe('fulfilled');
    const sub = await subsRepo.findByUserId(1);
    expect(sub!.planId).toBe(2);
    expect(sub!.entitlementSnapshot).toMatchObject({ maxConnectionMetas: 5000 });
  });

  it('extends the existing periodEndTime instead of overwriting remaining time', async () => {
    const { svc, subsRepo } = makeService();
    const existingEnd = new Date(Date.now() + 20 * 24 * 3600 * 1000); // 20 天剩余
    await subsRepo.create({ userId: 1, planId: 2, status: 'active', entitlementSnapshot: { maxConnectionMetas: 5000 }, periodStartTime: new Date(), periodEndTime: existingEnd });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    const cb = SUCCESS_CALLBACK(orderNo, 'wx-1', 9900);
    await svc.handleCallback('wechat', cb.raw, cb.headers);

    const sub = await subsRepo.findByUserId(1);
    // 新的到期日 ≈ 既有到期日 + 30 天，而非 now + 30 天（不吞 20 天剩余）。
    const expected = existingEnd.getTime() + 30 * 24 * 3600 * 1000;
    expect(sub!.periodEndTime!.getTime()).toBeGreaterThanOrEqual(expected - 1000);
    expect(sub!.periodEndTime!.getTime()).toBeLessThanOrEqual(expected + 1000);
  });

  it('fulfills an alipay order via its own alipay callback (cross-channel isolation)', async () => {
    const { svc, orderRepo, subsRepo } = makeService();
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null });
    await svc.createOrder(1, 'pro', 'wechat');
    const alipay = await svc.createOrder(1, 'pro', 'alipay');

    const cb = SUCCESS_CALLBACK(alipay.orderNo, 'ali-1', 9900);
    const outcome = await svc.handleCallback('alipay', cb.raw, cb.headers);

    expect(outcome.kind).toBe('fulfilled');
    const order = await orderRepo.findByOrderNo(alipay.orderNo);
    expect(order!.status).toBe('fulfilled');
    expect(order!.channel).toBe('alipay');
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
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    const cb = SUCCESS_CALLBACK(orderNo, 'wx-dup', 9900);
    await svc.handleCallback('wechat', cb.raw, cb.headers);
    const outcome = await svc.handleCallback('wechat', cb.raw, cb.headers);
    expect(outcome.kind).toBe('duplicate');
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
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null });
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
      personalPlanRepo: planRepo,
      personalSubscriptionRepo: subsRepo,
      auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any),
      runner: async (fn) => fn({} as Queryable),
      gatewayFor: () => capturingGateway,
    });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null });
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
      personalPlanRepo: planRepo,
      personalSubscriptionRepo: subsRepo,
      auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any),
      runner: async (fn) => fn({} as Queryable),
      gatewayFor: () => capturingGateway,
    });
    const { orderNo } = await svc.createOrder(1, 'pro', 'wechat');
    await subsRepo.create({ userId: 1, planId: 1, status: 'active', entitlementSnapshot: {}, periodStartTime: new Date(), periodEndTime: null });
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