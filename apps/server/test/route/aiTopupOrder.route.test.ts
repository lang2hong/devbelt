import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { aiTopupOrderRoutes } from '../../src/modules/ai/route/topup.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { AiTopupService } from '../../src/modules/ai/service/aiTopupService.js';
import { MemoryAiTopupRepo } from '../helpers/fakeAiTopupRepo.js';
import { MemoryPaymentGateway } from '../../src/modules/billing/service/paymentChannel.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { FakeUserRepo, FakeRateLimitRepo } from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const UUID = '123e4567-e89b-42d3-8456-426614174000';

async function build(opts: { paymentEnabled?: boolean; alipayConfigured?: boolean } = {}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const auditRepo = new FakeAuditRepo();
  const auditWriter = new AuditWriter(auditRepo);
  const topupRepo = new MemoryAiTopupRepo();
  topupRepo.seedSku({ code: 'topup_500k', tokens: 500_000, priceCents: 900, validDays: 365, sortOrder: 0 });
  topupRepo.seedSku({ code: 'topup_off', tokens: 1, priceCents: 1, status: 'disabled', sortOrder: 1 });
  const topup = new AiTopupService(topupRepo, (fn) => fn({} as Queryable));

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);

  await app.register(aiTopupOrderRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    rateLimiter,
    topup,
    auditWriter,
    paymentFeatureEnabled: () => opts.paymentEnabled ?? true,
    channelConfigured: (ch) => (ch === 'alipay' ? (opts.alipayConfigured ?? true) : true),
    gatewayFor: (ch) => new MemoryPaymentGateway(ch),
    exec: {} as never,
  });
  await app.ready();

  const consoleToken = (userId: number) =>
    tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
  const user = await userRepo.create('buyer@b.com', 'hash', undefined);
  const writeHeaders = async (userId = user.id, bodyKey = UUID) => {
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
  return { app, userRepo, auditRepo, topupRepo, user, writeHeaders };
}

describe('ai topup order routes（P9.1c 用户侧下单）', () => {
  it('下单成功：pending 订单 + 白名单支付参数 + 审计', async () => {
    const b = await build();
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/ai/topup-orders',
      headers: await b.writeHeaders(),
      payload: { skuCode: 'topup_500k', channel: 'wechat', mode: 'qr' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      order: { orderNo: string; status: string; skuCode: string; amountCents: number; channel: string; purpose: string; planCode: string | null };
      payParams: { codeUrl?: string };
    };
    expect(body.order).toMatchObject({ status: 'pending', skuCode: 'topup_500k', amountCents: 900, channel: 'wechat', purpose: 'topup', planCode: null });
    expect(body.payParams.codeUrl).toBeTruthy();
    expect(b.auditRepo.events.some((e) => e.eventType === 'payment.order.created' && e.targetId === body.order.orderNo)).toBe(true);
    expect([...b.topupRepo.orders.values()]).toHaveLength(1);
  });

  it('pending 复用：同人同 SKU 同渠道重复下单返回同一订单号', async () => {
    const b = await build();
    const first = await b.app.inject({
      method: 'POST',
      url: '/api/ai/topup-orders',
      headers: await b.writeHeaders(b.user.id, randomUUID()),
      payload: { skuCode: 'topup_500k', channel: 'wechat' },
    });
    const second = await b.app.inject({
      method: 'POST',
      url: '/api/ai/topup-orders',
      headers: await b.writeHeaders(b.user.id, randomUUID()),
      payload: { skuCode: 'topup_500k', channel: 'wechat' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.json() as { order: { orderNo: string } }).order.orderNo)
      .toBe((first.json() as { order: { orderNo: string } }).order.orderNo);
    expect([...b.topupRepo.orders.values()]).toHaveLength(1);
  });

  it('未知/停用 SKU → 404 TOPUP_SKU_NOT_FOUND', async () => {
    const b = await build();
    for (const skuCode of ['nope', 'topup_off']) {
      const res = await b.app.inject({
        method: 'POST',
        url: '/api/ai/topup-orders',
        headers: await b.writeHeaders(b.user.id, randomUUID()),
        payload: { skuCode, channel: 'wechat' },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe('TOPUP_SKU_NOT_FOUND');
    }
  });

  it('支付功能关闭 → 503；渠道未配置 → 503', async () => {
    const disabled = await build({ paymentEnabled: false });
    const res = await disabled.app.inject({
      method: 'POST',
      url: '/api/ai/topup-orders',
      headers: await disabled.writeHeaders(),
      payload: { skuCode: 'topup_500k', channel: 'wechat' },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe('FEATURE_TEMPORARILY_DISABLED');

    const noAlipay = await build({ alipayConfigured: false });
    const res2 = await noAlipay.app.inject({
      method: 'POST',
      url: '/api/ai/topup-orders',
      headers: await noAlipay.writeHeaders(),
      payload: { skuCode: 'topup_500k', channel: 'alipay' },
    });
    expect(res2.statusCode).toBe(503);
  });

  it('缺 CSRF → 403；未登录 → 401；非法渠道 → 400', async () => {
    const b = await build();
    const h = await b.writeHeaders();
    const { 'x-csrf-token': _c, cookie: _k, ...noCsrf } = h;
    const res = await b.app.inject({
      method: 'POST',
      url: '/api/ai/topup-orders',
      headers: noCsrf,
      payload: { skuCode: 'topup_500k', channel: 'wechat' },
    });
    expect(res.statusCode).toBe(403);

    const anon = await b.app.inject({ method: 'POST', url: '/api/ai/topup-orders' });
    expect(anon.statusCode).toBe(401);

    const badChannel = await b.app.inject({
      method: 'POST',
      url: '/api/ai/topup-orders',
      headers: await b.writeHeaders(b.user.id, randomUUID()),
      payload: { skuCode: 'topup_500k', channel: 'manual' },
    });
    expect(badChannel.statusCode).toBe(422); // schema enum 拒绝（VALIDATION_FAILED）
  });
});