import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { invoiceRoutes } from '../../src/route/invoices.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { CursorService } from '../../src/service/cursor.js';
import { InvoiceService } from '../../src/service/invoiceService.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import type { Order } from '../../src/domain/entities.js';

const ORIGIN = 'http://localhost:5173';
const UUID = '123e4567-e89b-42d3-8456-426614174000';

function fulfilledOrder(orderNo: string, userId: number): Order {
  return {
    id: 7, orderNo, userId, planCode: 'pro', planVersion: 1, amountCents: 9900, channel: 'wechat', status: 'fulfilled',
    channelTradeNo: 'wx-1', paidTime: new Date(), expiresTime: new Date(Date.now() + 60000),
    createTime: new Date(), updateTime: new Date(),
  };
}

async function build() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const orders = new Map<string, Order>();
  const invoices: Array<Record<string, unknown>> = [];
  let createCount = 0;

  const orderRepo = {
    async findByOrderNoForUpdate(_tx: Queryable, orderNo: string) { return orders.get(orderNo); },
    async findByOrderNo(orderNo: string) { return orders.get(orderNo); },
  };
  const invoiceRepo = {
    async create(_tx: Queryable, input: { userId: number; orderId: number | null; title: string; taxNo: string | null; email: string; amountCents: number }) {
      createCount += 1;
      const i = { id: invoices.length + 1, userId: input.userId, orderId: input.orderId, title: input.title, taxNo: input.taxNo, email: input.email, amountCents: input.amountCents, status: 'requested', createTime: new Date(), updateTime: new Date() };
      invoices.push(i);
      return i;
    },
    async listByUser(userId: number) { return invoices.filter((i) => i.userId === userId); },
  };
  const auditRepo = { insert: async () => ({}), insertInTx: async () => ({}) };
  const auditWriter = new AuditWriter(auditRepo as never);
  const invoiceService = new InvoiceService({ invoiceRepo: invoiceRepo as never, orderRepo: orderRepo as never, auditWriter });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 't', privateKey, publicKeys: new Map([['t', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 3));
  const rateLimiter = new RateLimitService({ increment: async () => 1, peek: async () => 0 } as never, false);
  const cursorService = new CursorService(Buffer.alloc(32, 5));
  const idem = new IdempotencyService({
    findByKey: async () => undefined,
    createProcessing: async (_e: Queryable, i: any) => ({
      id: 1, actorUserId: i.actorUserId, sessionId: i.sessionId, method: i.method,
      normalizedPath: i.normalizedPath, idempotencyKey: i.idempotencyKey, requestDigest: i.requestDigest,
      status: 'processing', httpStatus: null, responseBody: null, expiresTime: i.expiresTime,
      createTime: new Date(), updateTime: new Date(),
    }),
    complete: async () => {},
    prune: async () => 0,
  } as never, async (fn) => fn({} as Queryable));

  await app.register(invoiceRoutes, {
    tokenService,
    getUser: async () => ({ status: 'active', sessionVersion: 0, role: 'user' as const }),
    getSessionActive: async () => true,
    csrfService, consoleOrigin: ORIGIN, rateLimiter, idempotencyService: idem, cursorService, invoiceService,
  });
  await app.ready();

  const consoleToken = (userId: number) => tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
  const writeHeaders = (_userId: number, csrf: string) => ({
    origin: ORIGIN, 'x-csrf-token': csrf,
    cookie: `${csrfCookieName()}=${csrf}`, 'content-type': 'application/json', accept: 'application/json',
  });
  const setOrders = (ss: Array<[string, Order]>) => { orders.clear(); for (const [k, v] of ss) orders.set(k, v); };
  return { app, orders, invoices, createCount, consoleToken, csrfService, setOrders, writeHeaders };
}

async function authHeader(b: Awaited<ReturnType<typeof build>>, userId: number): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await b.consoleToken(userId)}` };
}

describe('invoice routes', () => {
  it('rejects without a console bearer token', async () => {
    const b = await build();
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/db/console/invoices',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects POST without CSRF/origin with 403', async () => {
    const b = await build();
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/db/console/invoices',
      headers: { ...(await authHeader(b, 1)), 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': UUID },
      payload: { orderNo: 'o1', title: 'X', email: 'x@a.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a missing Idempotency-Key with 422', async () => {
    const b = await build();
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/db/console/invoices',
      headers: { ...(await authHeader(b, 1)), ...b.writeHeaders(1, csrf) },
      payload: { orderNo: 'o1', title: 'X', email: 'x@a.com' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('lists empty and creates an invoice returning the stable DTO', async () => {
    const b = await build();
    b.setOrders([['ord-fulfilled', fulfilledOrder('ord-fulfilled', 1)]]);
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/db/console/invoices',
      headers: { ...(await authHeader(b, 1)), ...b.writeHeaders(1, csrf), 'idempotency-key': UUID },
      payload: { orderNo: 'ord-fulfilled', title: 'Acme', email: 'billing@a.com' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().invoice;
    expect(body.invoiceId).toBeDefined();
    expect(body.title).toBe('Acme');
    expect(body.amountCents).toBe(9900);
    expect(body.orderNo).toBeUndefined();
    expect(body.userId).toBeUndefined();

    const list = await b.app.inject({
      method: 'GET',
      url: '/api/db/console/invoices',
      headers: { ...(await authHeader(b, 1)), accept: 'application/json' },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].invoiceId).toBeDefined();
  });

  it('maps a non-fulfilled order to 409', async () => {
    const b = await build();
    const pending = { ...fulfilledOrder('ord-pending', 1), status: 'pending' as const };
    b.setOrders([['ord-pending', pending]]);
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/db/console/invoices',
      headers: { ...(await authHeader(b, 1)), ...b.writeHeaders(1, csrf), 'idempotency-key': UUID },
      payload: { orderNo: 'ord-pending', title: 'Acme', email: 'billing@a.com' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('maps another user\'s order to 404', async () => {
    const b = await build();
    b.setOrders([['ord-fulfilled', fulfilledOrder('ord-fulfilled', 2)]]);
    const csrf = b.csrfService.issue('ws');
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/db/console/invoices',
      headers: { ...(await authHeader(b, 1)), ...b.writeHeaders(1, csrf), 'idempotency-key': UUID },
      payload: { orderNo: 'ord-fulfilled', title: 'Acme', email: 'billing@a.com' },
    });
    expect(res.statusCode).toBe(404);
  });
});