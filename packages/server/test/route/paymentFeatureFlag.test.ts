import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { ordersWriteRoutes } from '../../src/route/orders.js';
import { paymentCallbackRoutes } from '../../src/route/paymentCallback.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { CursorService } from '../../src/service/cursor.js';
import { OrderService } from '../../src/service/paymentService.js';
import { MemoryPaymentGateway } from '../../src/service/paymentChannel.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import type { Order, Payment, Plan } from '../../src/domain/entities.js';

const ORIGIN = 'http://localhost:5173';

const PLAN: Plan = {
  id: 2, code: 'pro', kind: 'personal', name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0,
  status: 'active', version: 1,
  features: { allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 0, maxConnectionMetas: 5000, syncStorageBytes: 268435456, maxSavedConnections: 100, allowConnectionImport: true },
  createTime: new Date(), updateTime: new Date(),
};

function noopOrderRepo() {
  return {
    create: async () => ({} as Order),
    findByOrderNo: async () => undefined,
    findByOrderNoForUpdate: async () => undefined,
    listByUser: async () => [],
    findPendingByUserAndPlan: async () => undefined,
    advance: async () => false,
  };
}
function noopPaymentRepo() {
  return { create: async () => ({} as Payment), findByChannelTradeNo: async () => undefined };
}

async function build(paymentEnabled: boolean) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const orderService = new OrderService({
    orderRepo: noopOrderRepo() as never,
    paymentRepo: noopPaymentRepo() as never,
    planRepo: { findByCodeInTx: async () => PLAN, findByCode: async () => PLAN, findById: async () => PLAN } as never,
    personalSubscriptionRepo: { findByUserIdForUpdate: async () => undefined } as never,
    auditWriter: new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as never),
    runner: async (fn) => fn({} as Queryable),
    gatewayFor: (c) => new MemoryPaymentGateway(c),
  });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 't', privateKey, publicKeys: new Map([['t', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 3));
  const rateLimiter = new RateLimitService({ increment: async () => 1, peek: async () => 0 } as never, false);
  const cursorService = new CursorService(Buffer.alloc(32, 5));
  const auditWriter = new AuditWriter({ insert: async () => ({}), insertInTx: async () => ({}) } as never);

  const orderOpts = {
    tokenService, getUser: async () => ({ status: 'active', sessionVersion: 0, role: 'user' as const }),
    getSessionActive: async () => true, csrfService, consoleOrigin: ORIGIN, rateLimiter, cursorService, orderService,
    paymentFeatureEnabled: () => paymentEnabled,
  };
  await app.register(ordersWriteRoutes, orderOpts);
  await app.register(paymentCallbackRoutes, { orderService, auditWriter, rateLimiter, paymentFeatureEnabled: () => paymentEnabled });
  await app.ready();

  const consoleToken = (userId: number) => tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
  return { app, csrfService, consoleToken };
}

describe('payment feature flag (503)', () => {
  it('order create returns 503 when the payment feature is disabled', async () => {
    const b = await build(false);
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/orders',
      headers: {
        authorization: `Bearer ${await b.consoleToken(1)}`,
        origin: ORIGIN, 'x-csrf-token': csrf, cookie: `${csrfCookieName()}=${csrf}`,
        'content-type': 'application/json', accept: 'application/json',
      },
      payload: { planCode: 'pro', channel: 'wechat' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('FEATURE_TEMPORARILY_DISABLED');
    await b.app.close();
  });

  it('callback returns 503 when the payment feature is disabled', async () => {
    const b = await build(false);
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/public/payment-callback/wechat',
      headers: { 'content-type': 'application/json', 'x-payment-signature': 'x' },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('FEATURE_TEMPORARILY_DISABLED');
    await b.app.close();
  });

  it('order create proceeds (not 503) when enabled', async () => {
    const b = await build(true);
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/orders',
      headers: {
        authorization: `Bearer ${await b.consoleToken(1)}`,
        origin: ORIGIN, 'x-csrf-token': csrf, cookie: `${csrfCookieName()}=${csrf}`,
        'content-type': 'application/json', accept: 'application/json',
      },
      payload: { planCode: 'pro', channel: 'wechat' },
    });
    // 启用后走到下单：noop repo 的 create 返回空 → 后续 getOrder 返回 undefined → 500（无碍本断言）。
    expect(res.statusCode).not.toBe(503);
    await b.app.close();
  });
});