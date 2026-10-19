import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { consoleAiBillingRoutes } from '../../src/modules/admin/route/consoleAiBilling.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { CursorService } from '../../src/service/cursor.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { AiBillingService } from '../../src/modules/ai/service/aiBillingService.js';
import { MemoryAiBillingRepo, MemoryAiRequestLogRepo } from '../helpers/fakeAiBillingRepo.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { FakeUserRepo, FakeRateLimitRepo, FakeIdempotencyReceiptRepo } from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const ENV = { configured: true, baseUrl: 'https://env.example.com/v1', apiKey: 'env-key', model: 'env-model' };

async function build() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);
  const userRepo = new FakeUserRepo();
  const auditRepo = new FakeAuditRepo();
  const repo = new MemoryAiBillingRepo();
  const logRepo = new MemoryAiRequestLogRepo();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));
  const runner: TxRunner = (fn) => fn({} as Queryable);
  await app.register(consoleAiBillingRoutes, {
    cursorService: new CursorService(Buffer.alloc(32, 7)),
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false),
    idempotencyService: new IdempotencyService(new FakeIdempotencyReceiptRepo(), runner),
    billing: new AiBillingService(repo, ENV, Date.now, logRepo),
    auditWriter: new AuditWriter(auditRepo),
  });
  await app.ready();
  const token = (userId: number) => tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: 'ws', sessionVersion: 0 });
  const makeAdmin = async () => {
    const u = await userRepo.create('admin@b.com', 'hash', undefined);
    await userRepo.setRole(u.id, 'platform_admin');
    return u;
  };
  const writeHeaders = async (userId: number) => {
    const csrf = csrfService.issue('ws');
    return {
      authorization: `Bearer ${await token(userId)}`,
      origin: ORIGIN,
      'x-csrf-token': csrf,
      cookie: `${csrfCookieName()}=${csrf}`,
      'idempotency-key': randomUUID(),
      'content-type': 'application/json',
      accept: 'application/json',
    };
  };
  return { app, userRepo, auditRepo, repo, logRepo, makeAdmin, writeHeaders, token };
}

describe('console AI billing routes（计费引擎）', () => {
  it('未登录 401；非 admin 403', async () => {
    const b = await build();
    expect((await b.app.inject({ method: 'GET', url: '/api/admin/ai/billing-settings' })).statusCode).toBe(401);
    const nobody = await b.userRepo.create('n@b.com', 'hash');
    const res = await b.app.inject({ method: 'GET', url: '/api/admin/ai/billing-settings', headers: { authorization: `Bearer ${await b.token(nobody.id)}`, accept: 'application/json' } });
    expect(res.statusCode).toBe(403);
    await b.app.close();
  });

  it('GET settings：回显 env 对照与 Key 提示，**永不回明文**；GET pricing 全量', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const h = await b.writeHeaders(admin.id);
    const res = await b.app.inject({ method: 'GET', url: '/api/admin/ai/billing-settings', headers: { authorization: h.authorization, accept: 'application/json' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ upstreamApiKeyConfigured: false, globalMultiplier: 1, env: { model: 'env-model', baseUrl: 'https://env.example.com/v1', apiKeyConfigured: true } });
    expect(JSON.stringify(body)).not.toContain('env-key');

    const pricing = await b.app.inject({ method: 'GET', url: '/api/admin/ai/model-pricing', headers: { authorization: h.authorization, accept: 'application/json' } });
    expect((pricing.json() as { items: unknown[] }).items).toEqual([]);
    await b.app.close();
  });

  it('PATCH settings：写入 Key 只回提示；幂等请求体脱敏；审计不含 Key 值', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/ai/billing-settings',
      headers: await b.writeHeaders(admin.id),
      payload: { activeModel: 'qwen-plus', upstreamBaseUrl: 'https://db.example.com/v1/', upstreamApiKey: 'sk-db-1234', globalMultiplier: 1.1, reason: '接价' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ activeModel: 'qwen-plus', upstreamBaseUrl: 'https://db.example.com/v1', upstreamApiKeyConfigured: true, upstreamApiKeyHint: '…1234', globalMultiplier: 1.1 });
    expect(JSON.stringify(body)).not.toContain('sk-db-1234');
    expect(JSON.stringify(b.auditRepo.events)).not.toContain('sk-db-1234');
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.billing_settings.updated')).toBe(true);
    // 清除 Key
    const cleared = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/ai/billing-settings',
      headers: await b.writeHeaders(admin.id),
      payload: { clearUpstreamApiKey: true, reason: '换回 env' },
    });
    expect((cleared.json() as { upstreamApiKeyConfigured: boolean }).upstreamApiKeyConfigured).toBe(false);
    await b.app.close();
  });

  it('PATCH settings：缺 reason 422；非 https 422', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const noReason = await b.app.inject({ method: 'PATCH', url: '/api/admin/ai/billing-settings', headers: await b.writeHeaders(admin.id), payload: { globalMultiplier: 1 } });
    expect(noReason.statusCode).toBe(422);
    const insecure = await b.app.inject({ method: 'PATCH', url: '/api/admin/ai/billing-settings', headers: await b.writeHeaders(admin.id), payload: { upstreamBaseUrl: 'http://remote.example.com/v1', reason: 'x' } });
    expect(insecure.statusCode).toBe(422);
    await b.app.close();
  });

  it('计价表 POST/PATCH：201/200 + 审计；重复 409；未知 404；非法 422', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const created = await b.app.inject({
      method: 'POST',
      url: '/api/admin/ai/model-pricing',
      headers: await b.writeHeaders(admin.id),
      payload: { model: 'qwen-plus', providerCode: 'dashscope', inputCentsPerM: 80, outputCentsPerM: 200, reason: '计价' },
    });
    expect(created.statusCode).toBe(201);
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.model_pricing.created' && e.targetId === 'qwen-plus')).toBe(true);

    const dup = await b.app.inject({ method: 'POST', url: '/api/admin/ai/model-pricing', headers: await b.writeHeaders(admin.id), payload: { model: 'qwen-plus', reason: 'x' } });
    expect(dup.statusCode).toBe(409);

    const patched = await b.app.inject({
      method: 'PATCH',
      url: '/api/admin/ai/model-pricing/qwen-plus',
      headers: await b.writeHeaders(admin.id),
      payload: { weightOverride: 3, status: 'disabled', reason: '调权' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { pricing: { weightOverride: number; status: string } }).pricing).toMatchObject({ weightOverride: 3, status: 'disabled' });

    const miss = await b.app.inject({ method: 'PATCH', url: '/api/admin/ai/model-pricing/nope', headers: await b.writeHeaders(admin.id), payload: { status: 'disabled', reason: 'x' } });
    expect(miss.statusCode).toBe(404);

    const bad = await b.app.inject({ method: 'POST', url: '/api/admin/ai/model-pricing', headers: await b.writeHeaders(admin.id), payload: { model: 'x', inputCentsPerM: -1, reason: 'x' } });
    expect(bad.statusCode).toBe(422);
    await b.app.close();
  });

  it('GET finance：月度聚合回显；非法月份 422 + 审计', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    b.repo.usageByMonth.set('2026-10', {
      usageMonth: '2026-10',
      promptTokens: 1_000_000,
      completionTokens: 200_000,
      billingPromptTokens: 1_000_000,
      billingCompletionTokens: 200_000,
      requestCount: 5,
    });
    b.repo.revenueByMonth.set('2026-10', { topupCents: 900, planCents: 0 });
    const h = await b.writeHeaders(admin.id);
    const res = await b.app.inject({ method: 'GET', url: '/api/admin/ai/finance?month=2026-10', headers: { authorization: h.authorization, accept: 'application/json' } });
    expect(res.statusCode).toBe(200);
    const f = res.json();
    expect(f).toMatchObject({ usageMonth: '2026-10', revenue: { topupCents: 900, planCents: 0 } });
    expect(f.costCents).toBeNull(); // env 模型无计价行 → 成本未知（null）

    const bad = await b.app.inject({ method: 'GET', url: '/api/admin/ai/finance?month=bad', headers: { authorization: h.authorization, accept: 'application/json' } });
    expect(bad.statusCode).toBe(422);
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.finance.read')).toBe(true);
    await b.app.close();
  });

  it('计价 CRUD 透传 multiplierOverride（012 每模型倍率）', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const create = await b.app.inject({
      method: 'POST', url: '/api/admin/ai/model-pricing',
      headers: await b.writeHeaders(admin.id),
      payload: { model: 'm-ov', inputCentsPerM: 80, outputCentsPerM: 200, multiplierOverride: 1.5, reason: 'r' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().pricing).toMatchObject({ model: 'm-ov', multiplierOverride: 1.5 });

    const patch = await b.app.inject({
      method: 'PATCH', url: '/api/admin/ai/model-pricing/m-ov',
      headers: await b.writeHeaders(admin.id),
      payload: { multiplierOverride: null, reason: '回全局' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().pricing).toMatchObject({ multiplierOverride: null });
  });

  it('设置 typicalOutputRatio：合法写入、非法 422（012 测算占比）', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const ok = await b.app.inject({
      method: 'PATCH', url: '/api/admin/ai/billing-settings',
      headers: await b.writeHeaders(admin.id),
      payload: { typicalOutputRatio: 0.3, reason: 'r' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().typicalOutputRatio).toBeCloseTo(0.3, 2);
    const bad = await b.app.inject({
      method: 'PATCH', url: '/api/admin/ai/billing-settings',
      headers: await b.writeHeaders(admin.id),
      payload: { typicalOutputRatio: 1.2, reason: 'r' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('区间毛利统计：合计/逐月/每模型 + 审计（012）', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    await b.logRepo.insertInTx({} as never, {
      userId: 7, usageMonth: '2026-10', model: 'm-a', requestId: 'req-1',
      rawPromptTokens: 1_000_000, rawCompletionTokens: 200_000,
      billingPromptTokens: 1_100_000, billingCompletionTokens: 550_000,
      weight: 2.5, multiplier: 1.1, costCents: 120, status: 'completed', usageEstimated: false, latencyMs: 100,
    });
    b.repo.revenueByMonth.set('2026-10', { topupCents: 9900, planCents: 0 });

    const res = await b.app.inject({
      method: 'GET', url: '/api/admin/ai/finance/summary?from=2026-10&to=2026-10',
      headers: { authorization: `Bearer ${await b.token(admin.id)}`, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toMatchObject({ requestCount: 1, costCents: 120, topupCents: 9900, marginCents: 9900 - 120 });
    expect(body.months[0]).toMatchObject({ usageMonth: '2026-10', requestCount: 1, costCents: 120 });
    expect(body.models[0]).toMatchObject({ model: 'm-a', requestCount: 1, costCents: 120 });
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.finance.read')).toBe(true);

    expect((await b.app.inject({
      method: 'GET', url: '/api/admin/ai/finance/summary?from=bad&to=2026-10',
      headers: { authorization: `Bearer ${await b.token(admin.id)}`, accept: 'application/json' },
    })).statusCode).toBe(422);
    expect((await b.app.inject({
      method: 'GET', url: '/api/admin/ai/finance/summary?from=2024-01&to=2026-12',
      headers: { authorization: `Bearer ${await b.token(admin.id)}`, accept: 'application/json' },
    })).statusCode).toBe(422);
  });

  it('用户请求流水：分页 + DTO 字段（不含明文）+ 审计 + 坏游标 422（012）', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    for (let i = 1; i <= 3; i++) {
      await b.logRepo.insertInTx({} as never, {
        userId: 7, usageMonth: '2026-10', model: 'm-a', requestId: `req-${i}`,
        rawPromptTokens: 100 * i, rawCompletionTokens: 10 * i,
        billingPromptTokens: 110 * i, billingCompletionTokens: 25 * i,
        weight: 2.5, multiplier: 1.1, costCents: 1 * i, status: 'completed', usageEstimated: false, latencyMs: i,
      });
    }
    const page1 = await b.app.inject({
      method: 'GET', url: '/api/admin/ai/users/7/requests?limit=2',
      headers: { authorization: `Bearer ${await b.token(admin.id)}`, accept: 'application/json' },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json();
    expect(p1.items).toHaveLength(2);
    // id 倒序：最新在前（req-3）。
    expect(p1.items[0]).toMatchObject({ model: 'm-a', rawPromptTokens: 300, billingCompletionTokens: 75, costCents: 3, status: 'completed' });
    expect(p1.items.some((i: Record<string, unknown>) => i.messages !== undefined)).toBe(false);
    expect(p1.nextCursor).toBeTruthy();
    const page2 = await b.app.inject({
      method: 'GET', url: `/api/admin/ai/users/7/requests?limit=2&cursor=${p1.nextCursor}`,
      headers: { authorization: `Bearer ${await b.token(admin.id)}`, accept: 'application/json' },
    });
    expect(page2.json().items).toHaveLength(1);
    expect(page2.json().nextCursor).toBeNull();
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.quota.read')).toBe(true);
    expect((await b.app.inject({
      method: 'GET', url: '/api/admin/ai/users/7/requests?cursor=tampered.sig',
      headers: { authorization: `Bearer ${await b.token(admin.id)}`, accept: 'application/json' },
    })).statusCode).toBe(422);
    expect((await b.app.inject({
      method: 'GET', url: '/api/admin/ai/users/0/requests',
      headers: { authorization: `Bearer ${await b.token(admin.id)}`, accept: 'application/json' },
    })).statusCode).toBe(422);
  });
});