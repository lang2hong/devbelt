import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { ordersReadRoutes, ordersWriteRoutes } from '../../src/route/orders.js';
import { paymentCallbackRoutes } from '../../src/route/paymentCallback.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { CursorService } from '../../src/service/cursor.js';
import { OrderService } from '../../src/service/paymentService.js';
import { MemoryPaymentGateway, signMemoryCallback } from '../../src/service/paymentChannel.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import type { Order, Payment, Plan, PersonalSubscription } from '../../src/domain/entities.js';

const ORIGIN = 'http://localhost:5173';

const PLAN: Plan = {
  id: 2, code: 'pro', kind: 'personal', name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0,
  status: 'active', version: 1,
  features: { allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 0, maxConnectionMetas: 5000, syncStorageBytes: 268435456, maxSavedConnections: 100, allowConnectionImport: true },
  createTime: new Date(), updateTime: new Date(),
};

class FOrderRepo {
  store = new Map<string, Order>(); seq = 0;
  async create(i: any): Promise<Order> {
    const o = { id: ++this.seq, orderNo: i.orderNo, userId: i.userId, planCode: i.planCode, amountCents: i.amountCents, channel: i.channel, status: 'pending', channelTradeNo: null, paidTime: null, expiresTime: i.expiresTime, createTime: new Date(), updateTime: new Date() } as Order;
    this.store.set(i.orderNo, o); return o;
  }
  async findByOrderNo(n: string) { return this.store.get(n); }
  async findByOrderNoForUpdate(_e: Queryable, n: string) { return this.store.get(n); }
  async advance(_e: Queryable, i: any) {
    for (const o of this.store.values()) if (o.id === i.id && o.status === i.expectedStatus) { o.status = i.status; if (i.channelTradeNo) o.channelTradeNo = i.channelTradeNo; if (i.paidTime) o.paidTime = i.paidTime; return true; }
    return false;
  }
  async listByUser(uid: number, _c: number | undefined, limit: number) { return [...this.store.values()].filter((o) => o.userId === uid).slice(0, limit); }
  async findPendingByUserAndPlan(uid: number, plan: string, channel: string) { return [...this.store.values()].find((o) => o.userId === uid && o.planCode === plan && o.channel === channel && o.status === 'pending'); }
}

class FPaymentRepo {
  store: Payment[] = [];
  async create(_e: Queryable, i: any): Promise<Payment> { const p = { id: this.store.length + 1, ...i, createTime: new Date() } as Payment; this.store.push(p); return p; }
  async findByChannelTradeNo(_e: Queryable, ch: string, t: string) { return this.store.find((p) => p.channel === ch && p.channelTradeNo === t); }
}

class FPlanRepo {
  async findByCode(c: string) { return c === 'pro' ? PLAN : undefined; }
  async findById(id: number) { return id === 2 ? PLAN : undefined; }
  async findByCodeInTx(_e: Queryable, c: string) { return c === 'pro' ? PLAN : undefined; }
  async findByIdInTx(_e: Queryable, id: number) { return id === 2 ? PLAN : undefined; }
  async listActive() { return [PLAN]; }
  async listAll() { return [PLAN]; }
  async replaceFeaturesInTx() {}
  async updateMetaInTx() { return true; }
}

class FSubsRepo {
  subs = new Map<number, PersonalSubscription>();
  async findByUserId(uid: number) { return [...this.subs.values()].find((s) => s.userId === uid); }
  async findByUserIdInTx(_e: Queryable, uid: number) { return this.findByUserId(uid); }
  async findByUserIdForUpdate(_e: Queryable, uid: number) { return this.findByUserId(uid); }
  async create(i: any): Promise<PersonalSubscription> { const s = { id: this.subs.size + 1, userId: i.userId, planId: i.planId, status: i.status, periodStartTime: i.periodStartTime, periodEndTime: i.periodEndTime, version: 0, createTime: new Date(), updateTime: new Date() } as PersonalSubscription; this.subs.set(s.id, s); return s; }
  async update(_e: Queryable, i: any) { const s = this.subs.get(i.id); if (!s || s.version !== i.expectedVersion) return false; s.planId = i.planId; s.status = i.status; s.periodEndTime = i.periodEndTime; s.version += 1; return true; }
}

async function build() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const orderRepo = new FOrderRepo() as any;
  const paymentRepo = new FPaymentRepo() as any;
  const planRepo = new FPlanRepo() as any;
  const subsRepo = new FSubsRepo() as any;
  const auditWriter = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as any);

  const orderService = new OrderService({
    orderRepo, paymentRepo, planRepo, personalSubscriptionRepo: subsRepo,
    auditWriter, runner: async (fn) => fn({} as Queryable),
    gatewayFor: (c) => new MemoryPaymentGateway(c),
  });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 't', privateKey, publicKeys: new Map([['t', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 3));
  const rateLimiter = new RateLimitService({ increment: async () => 1, peek: async () => 0 } as any, false);
  const cursorService = new CursorService(Buffer.alloc(32, 5));

  const orderOpts = {
    tokenService, getUser: async () => ({ status: 'active', sessionVersion: 0, role: 'user' as const }),
    getSessionActive: async () => true, csrfService, consoleOrigin: ORIGIN, rateLimiter, cursorService, orderService,
  };
  await app.register(ordersReadRoutes, orderOpts);
  await app.register(ordersWriteRoutes, orderOpts);
  await app.register(paymentCallbackRoutes, { orderService, auditWriter, rateLimiter, allowStubSignature: true });
  await app.ready();

  const consoleToken = (userId: number) => tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
  return { app, orderRepo, paymentRepo, subsRepo, consoleToken, csrfService, tokenService };
}

describe('orders routes', () => {
  it('creates an order under a console session (CSRF + Origin)', async () => {
    const b = await build();
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/orders',
      headers: {
        authorization: `Bearer ${await b.consoleToken(1)}`,
        origin: ORIGIN,
        'x-csrf-token': csrf,
        cookie: `${csrfCookieName()}=${csrf}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload: { planCode: 'pro', channel: 'wechat' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.order.status).toBe('pending');
    expect(body.order.amountCents).toBe(9900);
    expect(body.payParams.codeUrl).toBeTruthy();
    expect(body.payParams).toEqual({ codeUrl: expect.any(String) });
  });

  it('rejects a create without CSRF/origin with 403', async () => {
    const b = await build();
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/orders',
      headers: { authorization: `Bearer ${await b.consoleToken(1)}`, 'content-type': 'application/json', accept: 'application/json' },
      payload: { planCode: 'pro', channel: 'wechat' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unsupported channel with 422', async () => {
    const b = await build();
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/orders',
      headers: {
        authorization: `Bearer ${await b.consoleToken(1)}`, origin: ORIGIN,
        'x-csrf-token': csrf, cookie: `${csrfCookieName()}=${csrf}`,
        'content-type': 'application/json', accept: 'application/json',
      },
      payload: { planCode: 'pro', channel: 'paypal' },
    });
    expect(res.statusCode).toBe(422);
  });

  async function createOrder(payload: Record<string, unknown>) {
    const b = await build();
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/orders',
      headers: {
        authorization: `Bearer ${await b.consoleToken(1)}`, origin: ORIGIN,
        'x-csrf-token': csrf, cookie: `${csrfCookieName()}=${csrf}`,
        'content-type': 'application/json', accept: 'application/json',
      },
      payload,
    });
    return res;
  }

  it('passes mode:qr through to the gateway (alipay codeUrl)', async () => {
    const res = await createOrder({ planCode: 'pro', channel: 'alipay', mode: 'qr' });
    expect(res.statusCode).toBe(201);
    expect(res.json().payParams.codeUrl).toBeTruthy();
    expect(res.json().payParams.redirectUrl).toBeUndefined();
  });

  it('passes mode:redirect through to the gateway (alipay redirectUrl)', async () => {
    const res = await createOrder({ planCode: 'pro', channel: 'alipay', mode: 'redirect' });
    expect(res.statusCode).toBe(201);
    expect(res.json().payParams.redirectUrl).toBeTruthy();
    expect(res.json().payParams.codeUrl).toBeUndefined();
  });

  it('rejects an invalid mode with 422', async () => {
    const res = await createOrder({ planCode: 'pro', channel: 'alipay', mode: 'popup' });
    expect(res.statusCode).toBe(422);
  });
});

describe('payment callback route', () => {
  it('rejects a callback with a bad signature', async () => {
    const b = await build();
    const order = await (b.orderRepo as any).create({ orderNo: 'x'.repeat(43), userId: 1, planCode: 'pro', amountCents: 9900, channel: 'wechat', expiresTime: new Date(Date.now() + 60000) });
    void order;
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/wechat',
      headers: { 'content-type': 'application/json', 'x-payment-signature': 'bad' },
      payload: { orderNo: 'x'.repeat(43), channelTradeNo: 'wx-1', amountCents: 9900, status: 'success' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PAYMENT_SIGNATURE_INVALID');
  });

  it('returns 200 for a post-signature domain failure (provider ack stops retry)', async () => {
    const b = await build();
    const raw = Buffer.from(JSON.stringify({ orderNo: 'x'.repeat(43), channelTradeNo: 'wx-1', amountCents: 9900, status: 'success' }));
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/wechat',
      headers: { 'content-type': 'application/json', 'x-payment-signature': signMemoryCallback(raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    // 微信 v3 JSON ack。
    expect(res.json()).toEqual({ code: 'SUCCESS', message: '成功' });
  });

  it('rejects an unknown channel with UNKNOWN_CHANNEL', async () => {
    const b = await build();
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/paypal',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_CHANNEL');
  });
});