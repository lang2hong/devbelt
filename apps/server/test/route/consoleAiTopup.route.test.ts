import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { consoleAiTopupRoutes } from '../../src/modules/admin/route/consoleAiTopup.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { AiTopupService } from '../../src/modules/ai/service/aiTopupService.js';
import { AiQuotaService } from '../../src/modules/ai/service/aiQuotaService.js';
import { MemoryAiTopupRepo } from '../helpers/fakeAiTopupRepo.js';
import { MemoryAiUsageRepo } from '../helpers/fakeAiUsageRepo.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { FakeUserRepo, FakePersonalSubscriptionRepo, FakePlanRepo, FakeRateLimitRepo, FakeIdempotencyReceiptRepo, makeFreePlan } from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const UUID = '123e4567-e89b-42d3-8456-426614174000';
const NOW = new Date('2026-10-15T00:00:00Z');

async function build(rateLimit = false) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const auditRepo = new FakeAuditRepo();
  const auditWriter = new AuditWriter(auditRepo);
  const topupRepo = new MemoryAiTopupRepo();
  topupRepo.seedSku({ code: 'sk_a', tokens: 5000, priceCents: 900, validDays: 30, sortOrder: 0 });
  topupRepo.seedSku({ code: 'sk_b', tokens: 20000, priceCents: 2900, validDays: 30, sortOrder: 1 });
  topupRepo.seedSku({ code: 'sk_off', tokens: 1, priceCents: 1, status: 'disabled', sortOrder: 2 });
  const usageRepo = new MemoryAiUsageRepo();
  const plans = new FakePlanRepo([makeFreePlan()]);
  const topup = new AiTopupService(topupRepo, usageRepo.runner(), () => NOW);
  const quota = new AiQuotaService(usageRepo, topupRepo, new FakePersonalSubscriptionRepo(), plans, usageRepo.runner());

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));
  const runner: TxRunner = (fn) => fn({} as Queryable);
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), rateLimit);

  await app.register(consoleAiTopupRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    rateLimiter,
    idempotencyService: new IdempotencyService(new FakeIdempotencyReceiptRepo(), runner),
    topup,
    quota,
    auditWriter,
  });
  await app.ready();

  const consoleToken = (userId: number) =>
    tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
  const makeAdmin = async (email = 'admin@b.com') => {
    const u = await userRepo.create(email, 'hash', undefined);
    await userRepo.setRole(u.id, 'platform_admin');
    return u;
  };
  const tokenFor = (userId: number) =>
    tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
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

  return { app, userRepo, auditRepo, topupRepo, usageRepo, makeAdmin, writeHeaders, tokenFor };
}

describe('console AI topup routes（P9.1b）', () => {
  it('未带 token → 401；非 admin → 403', async () => {
    const b = await build();
    const anon = await b.app.inject({ method: 'GET', url: '/api/admin/ai/skus' });
    expect(anon.statusCode).toBe(401);

    const nobody = await b.userRepo.create('nobody@b.com', 'hash');
    const forbidden = await b.app.inject({
      method: 'GET',
      url: '/api/admin/ai/skus',
      headers: { authorization: `Bearer ${await b.tokenFor(nobody.id)}`, accept: 'application/json' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('GET /api/admin/ai/skus 返回全量档位（含停用）+ 审计', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const token = await b.writeHeaders(admin.id);
    const res = await b.app.inject({
      method: 'GET',
      url: '/api/admin/ai/skus',
      headers: { authorization: token.authorization, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ code: string; status: string; priceCents: number }> };
    expect(body.items.map((i) => i.code)).toEqual(['sk_a', 'sk_b', 'sk_off']);
    expect(body.items[2].status).toBe('disabled');
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.skus.read')).toBe(true);
  });

  it('PATCH /api/admin/ai/skus/:code 改价 + 审计；未知 code → 404；缺 reason → 422', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const h = await b.writeHeaders(admin.id, randomUUID());
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/ai/skus/sk_a',
      headers: h,
      payload: { priceCents: 950, reason: '调价' },
    });
    expect(res.statusCode).toBe(200);
    const { sku } = res.json() as { sku: { priceCents: number } };
    expect(sku.priceCents).toBe(950);
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.sku.updated' && e.targetId === 'sk_a')).toBe(true);

    const miss = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/ai/skus/nope',
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { priceCents: 1, reason: 'x' },
    });
    expect(miss.statusCode).toBe(404);

    const noReason = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/ai/skus/sk_a',
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { priceCents: 1 },
    });
    expect(noReason.statusCode).toBe(422);
  });

  it('手工建单：金额二次确认一致 → 201 订单 fulfilled + grant + 审计；不一致 → 422 AMOUNT_MISMATCH', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const buyer = await b.userRepo.create('buyer@b.com', 'hash');

    const ok = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/topup-orders',
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { userId: buyer.id, skuCode: 'sk_a', expectedAmountCents: 900, reason: '客服补发' },
    });
    expect(ok.statusCode).toBe(201);
    const { order } = ok.json() as { order: { orderNo: string; status: string; tokens: number; grantInserted: boolean } };
    expect(order.status).toBe('fulfilled');
    expect(order.tokens).toBe(5000);
    expect(order.grantInserted).toBe(true);
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.topup.manual_created' && e.targetType === 'order')).toBe(true);
    expect([...b.topupRepo.grants.values()].filter((g) => g.userId === buyer.id)).toHaveLength(1);

    const mismatch = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/topup-orders',
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { userId: buyer.id, skuCode: 'sk_a', expectedAmountCents: 1, reason: '旧价误填' },
    });
    expect(mismatch.statusCode).toBe(422);
    expect((mismatch.json() as { error: { code: string } }).error.code).toBe('AMOUNT_MISMATCH');

    const disabled = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/topup-orders',
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { userId: buyer.id, skuCode: 'sk_off', expectedAmountCents: 1, reason: 'x' },
    });
    expect(disabled.statusCode).toBe(404);
  });

  it('履行：paid → fulfilled；重放幂等（grantInserted=false）；非 paid → 409 TOPUP_ORDER_STATE', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const buyer = await b.userRepo.create('buyer@b.com', 'hash');
    // 直接造一条 paid 的渠道订单（模拟回调丢失）
    const order = await b.topupRepo.insertTopupOrderInTx({} as Queryable, {
      orderNo: 'tp-paid-1', userId: buyer.id, skuCode: 'sk_a', amountCents: 900, channel: 'wechat', status: 'pending', expiresTime: NOW,
    });
    await b.topupRepo.setOrderStatusInTx({} as Queryable, order.id, 'pending', 'paid');

    const first = await b.app.inject({
      method: 'POST',
      url: `/api/admin/ai/topup-orders/tp-paid-1/fulfill`,
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { reason: '回调丢失补单' },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { order: { status: string; grantInserted: boolean } }).order).toMatchObject({ status: 'fulfilled', grantInserted: true });

    const second = await b.app.inject({
      method: 'POST',
      url: `/api/admin/ai/topup-orders/tp-paid-1/fulfill`,
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { reason: '重放' },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { order: { grantInserted: boolean } }).order.grantInserted).toBe(false);
    expect([...b.topupRepo.grants.values()].filter((g) => g.orderId === order.id)).toHaveLength(1);

    const pendingOrder = await b.topupRepo.insertTopupOrderInTx({} as Queryable, {
      orderNo: 'tp-pending-1', userId: buyer.id, skuCode: 'sk_a', amountCents: 900, channel: 'wechat', status: 'pending', expiresTime: NOW,
    });
    const bad = await b.app.inject({
      method: 'POST',
      url: `/api/admin/ai/topup-orders/tp-pending-1/fulfill`,
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { reason: 'x' },
    });
    expect(bad.statusCode).toBe(409);
    expect((bad.json() as { error: { code: string } }).error.code).toBe('TOPUP_ORDER_STATE');
    void pendingOrder;
  });

  it('退款：fulfilled → refunded（grants 作废）；幂等；未知订单 404', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const buyer = await b.userRepo.create('buyer@b.com', 'hash');
    const created = await new AiTopupService(b.topupRepo, (fn) => fn({} as Queryable), () => NOW)
      .createManualOrder({ userId: buyer.id, skuCode: 'sk_a' });
    const grant = [...b.topupRepo.grants.values()][0]!;

    const refund = await b.app.inject({
      method: 'POST',
      url: `/api/admin/ai/topup-orders/${created.orderNo}/refund`,
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { reason: '误发撤销' },
    });
    expect(refund.statusCode).toBe(200);
    expect((refund.json() as { order: { status: string } }).order.status).toBe('refunded');
    expect(grant.status).toBe('refunded');
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.topup.refunded')).toBe(true);

    const again = await b.app.inject({
      method: 'POST',
      url: `/api/admin/ai/topup-orders/${created.orderNo}/refund`,
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { reason: '重放' },
    });
    expect(again.statusCode).toBe(200);

    const missing = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/topup-orders/nope/refund',
      headers: await b.writeHeaders(admin.id, randomUUID()),
      payload: { reason: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('用户配额查询：快照 + grants 明细 + 近月用量 + 订单实付聚合 + 审计', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const buyer = await b.userRepo.create('buyer@b.com', 'hash');
    await new AiTopupService(b.topupRepo, (fn) => fn({} as Queryable), () => NOW)
      .createManualOrder({ userId: buyer.id, skuCode: 'sk_a' });
    // 补一笔已支付订单（含 paidTime）+ 一笔退款订单 → 聚合可验证。
    b.topupRepo.orders.set('ord-paid', {
      id: 99, orderNo: 'ord-paid', userId: buyer.id, skuCode: 'sk_a', amountCents: 2900,
      status: 'paid', channel: 'wechat', expiresTime: NOW, paidTime: new Date('2026-10-10T00:00:00Z'),
    });
    b.topupRepo.orders.set('ord-ref', {
      id: 100, orderNo: 'ord-ref', userId: buyer.id, skuCode: 'sk_b', amountCents: 900,
      status: 'refunded', channel: 'alipay', expiresTime: NOW,
    });
    // 近两月用量（计费 token 口径；先 ensure 行再入账）。
    await b.usageRepo.ensureRowInTx({} as Queryable, buyer.id, '2026-10');
    await b.usageRepo.ensureRowInTx({} as Queryable, buyer.id, '2026-09');
    await b.usageRepo.settleInTx({} as Queryable, buyer.id, '2026-10', {
      releaseReservedPromptTokens: 0, releaseReservedCompletionTokens: 0, promptTokens: 1200, completionTokens: 800,
    });
    await b.usageRepo.settleInTx({} as Queryable, buyer.id, '2026-09', {
      releaseReservedPromptTokens: 0, releaseReservedCompletionTokens: 0, promptTokens: 300, completionTokens: 100,
    });

    const res = await b.app.inject({
      method: 'GET',
      url: `/api/admin/ai/users/${buyer.id}/quota`,
      headers: { authorization: (await b.writeHeaders(admin.id)).authorization, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      snapshot: { topupRemaining: number; monthlyRemaining: number };
      grants: Array<{ skuCode: string; status: string; tokensTotal: number; expiresTime: string }>;
      months: Array<{ usageMonth: string; promptTokens: number; completionTokens: number; requestCount: number }>;
      topupOrders: { totalCount: number; paidCount: number; paidCents: number; refundedCount: number; lastPaidTime: string | null };
    };
    expect(body.snapshot.topupRemaining).toBe(5000);
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).toMatchObject({ skuCode: 'sk_a', status: 'active', tokensTotal: 5000 });
    expect(new Date(body.grants[0].expiresTime).getTime()).toBe(NOW.getTime() + 30 * 24 * 3600 * 1000);
    expect(body.months.map((m) => m.usageMonth)).toEqual(['2026-10', '2026-09']);
    expect(body.months[0]).toMatchObject({ promptTokens: 1200, completionTokens: 800, requestCount: 1 });
    expect(body.topupOrders).toMatchObject({ totalCount: 3, paidCount: 2, paidCents: 900 + 2900, refundedCount: 1 });
    expect(body.topupOrders.lastPaidTime).toContain('2026-10-10');
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.quota.read')).toBe(true);
  });

  it('写请求缺 CSRF → 403 FORBIDDEN', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const h = await b.writeHeaders(admin.id, randomUUID());
    const { 'x-csrf-token': _csrf, cookie: _cookie, ...noCsrf } = h;
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/topup-orders',
      headers: noCsrf,
      payload: { userId: 1, skuCode: 'sk_a', expectedAmountCents: 900, reason: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('幂等重放：同 Idempotency-Key 同 body → 同一订单（不重复入账）', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const buyer = await b.userRepo.create('buyer@b.com', 'hash');
    const payload = { userId: buyer.id, skuCode: 'sk_a', expectedAmountCents: 900, reason: '重放测试' };
    const key = randomUUID();
    const first = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/topup-orders',
      headers: await b.writeHeaders(admin.id, key),
      payload,
    });
    const second = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/topup-orders',
      headers: await b.writeHeaders(admin.id, key),
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.json() as { order: { orderNo: string } }).order.orderNo)
      .toBe((first.json() as { order: { orderNo: string } }).order.orderNo);
    expect([...b.topupRepo.grants.values()].filter((g) => g.userId === buyer.id)).toHaveLength(1);
  });
});