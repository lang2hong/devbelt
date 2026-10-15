import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { consoleAdminRoutes } from '../../src/modules/admin/route/consoleAdmin.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { ConsoleAdminService } from '../../src/modules/admin/service/consoleAdminService.js';
import { CursorService } from '../../src/service/cursor.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import {
  FakeUserRepo,
  FakeRefreshTokenRepo,
  FakePlanRepo,
  FakePlanFeatureDefRepo,
  FakePersonalSubscriptionRepo,
  FakeRateLimitRepo,
  FakeIdempotencyReceiptRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';
import type { IOrderRepo, IInvoiceRepo } from '../../src/repository/interfaces.js';
import type { Order, Invoice, PlanFeatureDef } from '../../src/domain/entities.js';

const ORIGIN = 'http://localhost:5173';

const ADMIN_FEATURE_DEFS: PlanFeatureDef[] = [
  { id: 1, key: 'maxSavedConnections', kind: 'personal', label: { en: 'Saved', zh: '保存' }, valueType: 'number', unit: 'count', sortOrder: 10 },
];
const UUID = '123e4567-e89b-42d3-8456-426614174000';

async function build(rateLimit = false) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const planRepo = new FakePlanRepo();
  const featureDefRepo = new FakePlanFeatureDefRepo(ADMIN_FEATURE_DEFS);
  const personalSubscriptionRepo = new FakePersonalSubscriptionRepo();
  const auditRepo = new FakeAuditRepo();
  const idemRepo = new FakeIdempotencyReceiptRepo();
  const auditWriter = new AuditWriter(auditRepo);
  const orders = new Map<string, Order>();
  const orderRepo: IOrderRepo = {
    create: async () => { throw new Error('unused'); },
    findByOrderNo: async (orderNo) => orders.get(orderNo),
    findByOrderNoForUpdate: async (_exec, orderNo) => orders.get(orderNo),
    findByIdForUpdate: async (_exec, id) => [...orders.values()].find((x) => x.id === id),
    advance: async (_exec, input) => {
      const o = [...orders.values()].find((x) => x.id === input.id);
      if (!o || o.status !== input.expectedStatus) return false;
      orders.set(o.orderNo, { ...o, status: input.status, channelTradeNo: input.channelTradeNo ?? o.channelTradeNo, paidTime: input.paidTime ?? o.paidTime });
      return true;
    },
    listByUser: async () => [],
    listAll: async (input) => {
      let items = [...orders.values()];
      if (input.userId !== undefined) items = items.filter((o) => o.userId === input.userId);
      if (input.status !== undefined) items = items.filter((o) => o.status === input.status);
      if (input.channel !== undefined) items = items.filter((o) => o.channel === input.channel);
      if (input.purpose !== undefined) items = items.filter((o) => o.purpose === input.purpose);
      if (input.planCode !== undefined) items = items.filter((o) => o.planCode === input.planCode);
      if (input.cursor !== undefined) items = items.filter((o) => o.id < input.cursor!);
      return items.slice(0, input.limit);
    },
    findPendingByUserAndPlan: async () => undefined,
    expirePending: async () => 0,
  };

  const invoices: Invoice[] = [];
  const invoiceRepo: IInvoiceRepo = {
    create: async () => { throw new Error('unused'); },
    listByUser: async () => [],
    findByIdForUpdate: async (_exec, id) => invoices.find((i) => i.id === id),
    advance: async (_exec, input) => {
      const i = invoices.find((x) => x.id === input.id);
      if (!i || i.status !== input.expectedStatus) return false;
      i.status = input.status;
      i.reason = input.reason;
      return true;
    },
    hasIssuedForOrder: async (_exec, orderId) => invoices.some((i) => i.orderId === orderId && i.status === 'issued'),
    listAll: async (input) => {
      let items = invoices;
      if (input.userId !== undefined) items = items.filter((i) => i.userId === input.userId);
      if (input.status !== undefined) items = items.filter((i) => i.status === input.status);
      if (input.cursor !== undefined) items = items.filter((i) => i.id < input.cursor!);
      return items.slice(0, input.limit);
    },
  };

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));
  const runner: TxRunner = async (fn) => fn({} as Queryable);
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), rateLimit);

  const adminService = new ConsoleAdminService({
    userRepo,
    refreshTokenRepo,
    planRepo,
    featureDefRepo,
    personalSubscriptionRepo,
    auditRepo,
    orderRepo,
    invoiceRepo,
    auditWriter,
    syncStateRepo: {} as never,
    syncRecordService: {} as never,
  });

  await app.register(consoleAdminRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    rateLimiter,
    idempotencyService: new IdempotencyService(idemRepo, runner),
    adminService,
    cursorService: new CursorService(Buffer.alloc(32, 7)),
    planRepo,
    serverVersion: '1.0.0',
    consoleApiVersion: '1',
  });
  await app.ready();

  const consoleToken = (userId: number) => tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
  const makeAdmin = async (email = 'admin@b.com') => {
    const u = await userRepo.create(email, 'hash', undefined);
    await userRepo.setRole(u.id, 'platform_admin');
    return u;
  };
  const writeHeaders = async (userId: number, bodyKey = UUID) => {
    const csrf = csrfService.issue('ws');
    return {
      authorization: `Bearer ${await consoleToken(userId)}`,
      origin: ORIGIN,
      'x-csrf-token': csrf,
      cookie: `${csrfCookieName()}=${csrf}`,
      'idempotency-key': bodyKey,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  };

  return {
    app,
    userRepo,
    refreshTokenRepo,
    personalSubscriptionRepo,
    auditRepo,
    orders,
    invoices,
    makeAdmin,
    consoleToken,
    writeHeaders,
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 1,
    orderNo: 'ord-1',
    userId: 99,
    purpose: 'plan',
    planCode: 'pro',
    planVersion: 1,
    skuCode: null,
    amountCents: 9900,
    channel: 'wechat',
    status: 'paid',
    channelTradeNo: 'wx-1',
    paidTime: new Date(),
    expiresTime: new Date(Date.now() + 100000),
    createTime: new Date(),
    updateTime: new Date(),
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 1,
    userId: 99,
    orderId: null,
    title: 'Acme Inc.',
    taxNo: null,
    email: 'billing@b.com',
    amountCents: 9900,
    status: 'requested',
    reason: null,
    createTime: new Date(),
    updateTime: new Date(),
    ...overrides,
  };
}

describe('console admin routes', () => {
  it('non-admin is forbidden', async () => {
    const b = await build();
    const u = await b.userRepo.create('nobody@b.com', 'hash');
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${await b.consoleToken(u.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await b.app.close();
  });

  it('platform admin lists users', async () => {
    const b = await build();
    const admin = await b.makeAdmin('admin@b.com');
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].email).toBe('admin@b.com');
    expect(items[0].role).toBe('platform_admin');
    await b.app.close();
  });

  it('invalid cursor returns 422 INVALID_CURSOR', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/users?cursor=garbage',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_CURSOR');
    await b.app.close();
  });

  it('disabling a user revokes its sessions and bumps sessionVersion', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const target = await b.userRepo.create('target@b.com', 'hash');
    const tok = await b.refreshTokenRepo.create({} as Queryable, {
      userId: target.id, deviceId: null, tokenHash: 'h', familyId: 'fam', expiresTime: new Date(Date.now() + 100000),
    });

    const res = await b.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}/status`,
      headers: await b.writeHeaders(admin.id),
      payload: { status: 'disabled', reason: 'abuse' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.status).toBe('disabled');

    const updated = await b.userRepo.findById(target.id);
    expect(updated?.status).toBe('disabled');
    expect(updated?.sessionVersion).toBe(1);
    expect(tok.revokedTime).not.toBeNull();
    await b.app.close();
  });

  it('subscription adjust with stale expectedVersion returns 409', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const target = await b.userRepo.create('sub@b.com', 'hash');
    await b.personalSubscriptionRepo.create({ userId: target.id, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });

    const res = await b.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}/subscription`,
      headers: await b.writeHeaders(admin.id),
      payload: { planCode: 'free', reason: 'upgrade', expectedVersion: 999 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUBSCRIPTION_VERSION_CONFLICT');
    await b.app.close();
  });

  it('rejects a past periodEndTime on user subscription', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const target = await b.userRepo.create('sub2@b.com', 'hash');
    await b.personalSubscriptionRepo.create({ userId: target.id, planId: 1, status: 'active', periodStartTime: new Date(), periodEndTime: null });

    const res = await b.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}/subscription`,
      headers: await b.writeHeaders(admin.id),
      payload: { planCode: 'free', reason: 'extend', expectedVersion: 0, periodEndTime: new Date(Date.now() - 3600 * 1000).toISOString() },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });

  it('rejects a periodEndTime earlier than periodStartTime', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const target = await b.userRepo.create('sub3@b.com', 'hash');
    const start = new Date(Date.now() + 48 * 3600 * 1000);
    await b.personalSubscriptionRepo.create({ userId: target.id, planId: 1, status: 'active', periodStartTime: start, periodEndTime: null });

    const res = await b.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${target.id}/subscription`,
      headers: await b.writeHeaders(admin.id),
      payload: { planCode: 'free', reason: 'x', expectedVersion: 0, periodEndTime: new Date(start.getTime() - 24 * 3600 * 1000).toISOString() },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });

  it('audit export above cap is rejected', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/admin/audit/exports',
      headers: await b.writeHeaders(admin.id),
      payload: { format: 'json', filters: {}, expectedCountUpperBound: 10001 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('EXPORT_TOO_LARGE');
    await b.app.close();
  });

  it('audit query with only an ancient fromTime is rejected (31-day bound)', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const ancientFrom = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const res = await b.app.inject({
      method: 'GET',
      url: `/api/admin/audit?fromTime=${encodeURIComponent(ancientFrom)}`,
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });

  it('audit export without an Idempotency-Key is rejected', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const csrf = await b.writeHeaders(admin.id);
    const { 'idempotency-key': _, ...headers } = csrf;
    void _;
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/admin/audit/exports',
      headers,
      payload: { format: 'json', filters: {} },
    });
    expect(res.statusCode).toBe(422);
    await b.app.close();
  });

  it('audit export replays the same file on the same key without re-auditing', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    await b.auditRepo.insert({
      eventTime: new Date(),
      actorUserId: admin.id,
      actorRole: 'platform_admin',
      eventType: 'auth.login.success',
      targetType: null,
      targetId: null,
      sourceIp: null,
      requestId: null,
      result: 'success',
      failureCode: null,
      reason: null,
    });
    const headers = await b.writeHeaders(admin.id);
    const payload = { format: 'json', filters: {} };

    const first = await b.app.inject({ method: 'POST', url: '/api/admin/audit/exports', headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-disposition']).toContain('attachment');

    const second = await b.app.inject({ method: 'POST', url: '/api/admin/audit/exports', headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);

    await new Promise((r) => setTimeout(r, 0));
    expect(b.auditRepo.events.filter((e) => e.eventType === 'admin.audit.export')).toHaveLength(1);
    await b.app.close();
  });

  it('completed export replays even when the export bucket is exhausted; new key is 429', async () => {
    const b = await build(true);
    const admin = await b.makeAdmin();
    const payload = { format: 'json', filters: {} };
    const doExport = async (key: string) => {
      const headers = await b.writeHeaders(admin.id, key);
      return b.app.inject({ method: 'POST', url: '/api/admin/audit/exports', headers, payload });
    };

    const firstKey = randomUUID();
    const first = await doExport(firstKey);
    expect(first.statusCode).toBe(200);

    // 耗尽导出 bucket（10/h）：再 9 次成功，bucket = 10。
    for (let i = 0; i < 9; i += 1) {
      const r = await doExport(randomUUID());
      expect(r.statusCode).toBe(200);
    }

    // 已完成回执优先于限流：同键重放仍返回首次结果，不消耗额度。
    const replay = await doExport(firstKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);

    // 新 key 超出额度 → 429。
    const exhausted = await doExport(randomUUID());
    expect(exhausted.statusCode).toBe(429);
    await b.app.close();
  });

  it('version endpoint is rate-limited for admins', async () => {
    const b = await build(true);
    const admin = await b.makeAdmin();
    const headers = { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' };
    let last = 0;
    for (let i = 0; i < 61; i += 1) {
      const res = await b.app.inject({ method: 'GET', url: '/api/console/version', headers });
      last = res.statusCode;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    await b.app.close();
  });

  it('version endpoint requires platform admin', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const ok = await b.app.inject({
      method: 'GET',
      url: '/api/console/version',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().consoleApiVersion).toBe('1');

    const nobody = await b.userRepo.create('ver-nobody@b.com', 'hash');
    const denied = await b.app.inject({
      method: 'GET',
      url: '/api/console/version',
      headers: { authorization: `Bearer ${await b.consoleToken(nobody.id)}`, accept: 'application/json' },
    });
    expect(denied.statusCode).toBe(403);
    await b.app.close();
  });

  it('refund: paid → refunded (reason recorded)', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-1', makeOrder({ id: 1, orderNo: 'ord-1', status: 'paid' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/ord-1/refund',
      headers: await b.writeHeaders(admin.id),
      payload: { reason: 'customer request' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('refunded');
    expect(b.orders.get('ord-1')?.status).toBe('refunded');
    await b.app.close();
  });

  it('refund: fulfilled → refunded', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-2', makeOrder({ id: 2, orderNo: 'ord-2', status: 'fulfilled' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/ord-2/refund',
      headers: await b.writeHeaders(admin.id),
      payload: { reason: 'duplicate charge' },
    });
    expect(res.statusCode).toBe(200);
    expect(b.orders.get('ord-2')?.status).toBe('refunded');
    await b.app.close();
  });

  it('refund: non-paid/fulfilled order is rejected 409', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-3', makeOrder({ id: 3, orderNo: 'ord-3', status: 'pending' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/ord-3/refund',
      headers: await b.writeHeaders(admin.id),
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORDER_INVALID_STATE');
    await b.app.close();
  });

  it('refund: order with an issued invoice is rejected 409', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-9', makeOrder({ id: 9, orderNo: 'ord-9', status: 'fulfilled' }));
    b.invoices.push(makeInvoice({ id: 9, orderId: 9, status: 'issued' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/ord-9/refund',
      headers: await b.writeHeaders(admin.id),
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORDER_INVALID_STATE');
    expect(b.orders.get('ord-9')?.status).toBe('fulfilled');
    await b.app.close();
  });

  it('refund: unknown order is 404', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/nope/refund',
      headers: await b.writeHeaders(admin.id),
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await b.app.close();
  });

  it('refund: missing reason is rejected by schema', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-1', makeOrder({ id: 1, orderNo: 'ord-1', status: 'paid' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/ord-1/refund',
      headers: await b.writeHeaders(admin.id),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });

  it('refund: whitespace-only reason is rejected without mutating the order', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-1', makeOrder({ id: 1, orderNo: 'ord-1', status: 'paid' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/ord-1/refund',
      headers: await b.writeHeaders(admin.id),
      payload: { reason: '   ' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(b.orders.get('ord-1')?.status).toBe('paid');
    await b.app.close();
  });

  it('invoice: requested → issued without reason', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.invoices.push(makeInvoice({ id: 1, status: 'requested' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/invoices/1',
      headers: await b.writeHeaders(admin.id),
      payload: { status: 'issued' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('issued');
    expect(b.invoices[0].status).toBe('issued');
    await b.app.close();
  });

  it('invoice: requested → rejected/failed requires reason', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.invoices.push(makeInvoice({ id: 1, status: 'requested' }));

    const noReason = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/invoices/1',
      headers: await b.writeHeaders(admin.id),
      payload: { status: 'rejected' },
    });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error.code).toBe('VALIDATION_FAILED');

    const ok = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/invoices/1',
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { status: 'failed', reason: 'backend failed' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('failed');
    expect(b.invoices[0].status).toBe('failed');
    expect(b.invoices[0].reason).toBe('backend failed');
    await b.app.close();
  });

  it('invoice: non-requested invoice cannot be processed', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.invoices.push(makeInvoice({ id: 1, status: 'issued' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/invoices/1',
      headers: await b.writeHeaders(admin.id),
      payload: { status: 'failed', reason: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORDER_INVALID_STATE');
    await b.app.close();
  });

  it('invoice: admin lists invoices across users', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.invoices.push(makeInvoice({ id: 1, userId: 10, title: 'A' }));
    b.invoices.push(makeInvoice({ id: 2, userId: 20, title: 'B', status: 'issued' }));
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/invoices',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
    await b.app.close();
  });

  it('invoice: non-positive-int userId filter is rejected 422', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/invoices?userId=abc',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });

  it('invoice: unknown status filter is rejected 422', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/invoices?status=typo',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });

  it('invoice: requested invoice cannot be issued after its order is refunded', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-5', makeOrder({ id: 5, orderNo: 'ord-5', status: 'refunded' }));
    b.invoices.push(makeInvoice({ id: 1, orderId: 5, status: 'requested' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/invoices/1',
      headers: await b.writeHeaders(admin.id),
      payload: { status: 'issued' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORDER_INVALID_STATE');
    expect(b.invoices[0].status).toBe('requested');
    await b.app.close();
  });

  it('orders: topup 订单 DTO 带 purpose/skuCode（P9.1）', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-t1', makeOrder({ id: 9, orderNo: 'ord-t1', purpose: 'topup', planCode: null, skuCode: 'topup_500k', channel: 'manual', status: 'fulfilled' }));
    b.orders.set('ord-p1', makeOrder({ id: 8, orderNo: 'ord-p1', status: 'paid' }));
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/orders',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Array<{ orderNo: string; purpose: string; skuCode: string | null; planCode: string | null; channel: string }> }).items;
    const topup = items.find((i) => i.orderNo === 'ord-t1')!;
    expect(topup).toMatchObject({ purpose: 'topup', skuCode: 'topup_500k', planCode: null, channel: 'manual' });
    expect(items.find((i) => i.orderNo === 'ord-p1')).toMatchObject({ purpose: 'plan', skuCode: null });

    // purpose 过滤
    const filtered = await b.app.inject({
      method: 'GET',
      url: '/api/admin/orders?purpose=topup',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    const filteredItems = (filtered.json() as { items: Array<{ orderNo: string }> }).items;
    expect(filteredItems.map((i) => i.orderNo)).toEqual(['ord-t1']);
    await b.app.close();
  });

  it('refund: topup 订单拒绝通用退款（须走加油包退款路径，P9.1）', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.orders.set('ord-t2', makeOrder({ id: 10, orderNo: 'ord-t2', purpose: 'topup', planCode: null, skuCode: 'topup_2m', channel: 'manual', status: 'fulfilled' }));
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/orders/ord-t2/refund',
      headers: await b.writeHeaders(admin.id),
      payload: { reason: 'wrong path' },
    });
    expect(res.statusCode).toBe(409);
    expect(b.orders.get('ord-t2')?.status).toBe('fulfilled'); // 未被改动
    await b.app.close();
  });

  it('orders: non-positive-int userId filter is rejected 422', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/orders?userId=abc',
      headers: { authorization: `Bearer ${await b.consoleToken(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await b.app.close();
  });
});