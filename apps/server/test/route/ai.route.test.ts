import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { aiRoutes } from '../../src/modules/ai/module.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { requestId } from '../../src/middleware/requestId.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { EXTENSION_SCOPES } from '../../src/domain/enums.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { AiQuotaService, monthKey } from '../../src/modules/ai/service/aiQuotaService.js';
import { AiProxyService } from '../../src/modules/ai/service/aiProxyService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { MemoryAiUsageRepo } from '../helpers/fakeAiUsageRepo.js';
import { MemoryAiTopupRepo } from '../helpers/fakeAiTopupRepo.js';
import { AiTopupService } from '../../src/modules/ai/service/aiTopupService.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import {
  FakePlanRepo,
  FakePersonalSubscriptionRepo,
  FakeRateLimitRepo,
  FakeUserRepo,
  makeFreePlan,
  makeProPlan,
} from '../helpers/fakeRepos.js';

const SESSION = 'test-session-ai';

interface BuildOptions {
  fetchImpl: typeof fetch;
  configured?: boolean;
  limit?: number;
  rateLimitPerMinute?: number;
}

function sseBody(events: string[]): string {
  return `${events.map((e) => `data: ${e}\n\n`).join('')}data: [DONE]\n\n`;
}

async function buildApp(opts: BuildOptions): Promise<{
  app: FastifyInstance;
  token: string;
  userId: number;
  usageRepo: MemoryAiUsageRepo;
  topupRepo: MemoryAiTopupRepo;
  settleReservedCleared: () => boolean;
}> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);

  const userRepo = new FakeUserRepo();
  const user = await userRepo.create('ai@b.com', 'hash', 'AI');

  const plans = new FakePlanRepo([makeFreePlan(), makeProPlan()]);
  if (opts.limit !== undefined) {
    const free = plans.plans.find((p) => p.code === 'free')!;
    free.features = { ...free.features, maxAiTokensMonthly: opts.limit };
  }
  const usageRepo = new MemoryAiUsageRepo();
  const topupRepo = new MemoryAiTopupRepo();
  const quota = new AiQuotaService(usageRepo, topupRepo, new FakePersonalSubscriptionRepo(), plans, usageRepo.runner());
  const topup = new AiTopupService(topupRepo, usageRepo.runner());
  const proxy = new AiProxyService({
    config: {
      configured: opts.configured ?? true,
      baseUrl: 'https://up.test/v1',
      apiKey: 'k',
      model: 'm1',
    },
    quota,
    audit: new AuditWriter(new FakeAuditRepo()),
    log: () => {},
    fetchImpl: opts.fetchImpl,
  });

  await app.register(aiRoutes, {
    tokenService,
    getUser: async (id: number) => userRepo.findById(id),
    getSessionActive: async () => true,
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), true),
    proxy,
    quota,
    topup,
    rateLimitPerMinute: opts.rateLimitPerMinute,
  });
  await app.ready();

  const token = await tokenService.signAccessToken({
    userId: user.id,
    aud: 'extension',
    scope: [...EXTENSION_SCOPES],
    sessionId: SESSION,
    sessionVersion: 0,
  });
  return {
    app,
    token,
    userId: user.id,
    usageRepo,
    topupRepo,
    settleReservedCleared: () => {
      const row = usageRepo.get(user.id, monthKey(new Date()));
      return !!row && row.reservedPromptTokens === 0 && row.reservedCompletionTokens === 0;
    },
  };
}

const CHAT_PAYLOAD = { messages: [{ role: 'user', content: '你好' }] };

describe('POST /api/ai/chat（认证 / 配额 / 限流 / 配置）', () => {
  it('未带 token → 401', async () => {
    const { app } = await buildApp({ fetchImpl: (async () => new Response('')) as typeof fetch });
    const res = await app.inject({ method: 'POST', url: '/api/ai/chat', payload: CHAT_PAYLOAD });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('额度耗尽 → 409 AI_QUOTA_EXCEEDED（带 limit/used/reserved/resetAt）', async () => {
    const { app, token, userId, usageRepo } = await buildApp({
      fetchImpl: (async () => new Response('')) as typeof fetch,
      limit: 100,
    });
    usageRepo.seed(userId, monthKey(new Date()), { promptTokens: 100 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: { authorization: `Bearer ${token}` },
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'AI_QUOTA_EXCEEDED',
      limit: 100,
      used: 100,
      reserved: 0,
    });
    expect((res.json() as { resetAt: string }).resetAt).toMatch(/T00:00:00\.000Z$/);
    await app.close();
  });

  it('上游未配置 → 503 AI_PROVIDER_ERROR（服务可用性 fail-closed）', async () => {
    const { app, token } = await buildApp({
      fetchImpl: (async () => new Response('')) as typeof fetch,
      configured: false,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: { authorization: `Bearer ${token}` },
      payload: CHAT_PAYLOAD,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'AI_PROVIDER_ERROR' });
    await app.close();
  });

  it('固定窗限流：超过每分钟上限 → 429', async () => {
    const { app, token } = await buildApp({
      fetchImpl: (async () => new Response('')) as typeof fetch,
      configured: false,
      rateLimitPerMinute: 1,
    });
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/ai/chat',
        headers: { authorization: `Bearer ${token}` },
        payload: CHAT_PAYLOAD,
      });
    expect((await call()).statusCode).toBe(503);
    const second = await call();
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await app.close();
  });

  it('请求体非法 → 400 VALIDATION_FAILED', async () => {
    const { app, token } = await buildApp({ fetchImpl: (async () => new Response('')) as typeof fetch });
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/chat',
      headers: { authorization: `Bearer ${token}` },
      payload: { messages: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /api/ai/chat（SSE 端到端）', () => {
  it('hijack 后流式回包 + finish usage 落账', async () => {
    const upstream = sseBody([
      '{"choices":[{"delta":{"content":"你好"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":9,"total_tokens":59}}',
    ]);
    const { app, token, userId, usageRepo, settleReservedCleared } = await buildApp({
      fetchImpl: (async () => new Response(upstream, { status: 200 })) as typeof fetch,
      limit: 100_000,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${address.port}/api/ai/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(CHAT_PAYLOAD),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);

    const row = usageRepo.get(userId, monthKey(new Date()))!;
    expect(row).toMatchObject({ promptTokens: 50, completionTokens: 9, requestCount: 1 });
    expect(settleReservedCleared()).toBe(true);
    await app.close();
  });
});

describe('GET /api/ai/usage', () => {
  it('GET /api/ai/skus 返回上架档位（P9.1）', async () => {
    const { app, token, topupRepo } = await buildApp({ fetchImpl: (async () => new Response('')) as typeof fetch });
    topupRepo.seedSku({ code: 'sk_a', tokens: 5000, priceCents: 900 });
    topupRepo.seedSku({ code: 'sk_b', tokens: 20000, priceCents: 2900, sortOrder: 1 });
    topupRepo.seedSku({ code: 'sk_off', tokens: 1, priceCents: 1, status: 'disabled' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/skus',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ code: string; tokens: number; priceCents: number }> };
    expect(body.items.map((i) => i.code)).toEqual(['sk_a', 'sk_b']);
    expect(body.items[0]).toMatchObject({ tokens: 5000, priceCents: 900 });
  });

  it('未登录 401；登录返回当月快照', async () => {
    const { app, token } = await buildApp({
      fetchImpl: (async () => new Response('')) as typeof fetch,
      limit: 100_000,
    });
    const unauth = await app.inject({ method: 'GET', url: '/api/ai/usage' });
    expect(unauth.statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/usage',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ limit: 100_000, used: 0, reserved: 0, remaining: 100_000, requestCount: 0 });
    await app.close();
  });
});