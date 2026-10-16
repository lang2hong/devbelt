import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { generateKeyPairSync, randomUUID } from 'crypto';
import { consoleAiProvidersRoutes } from '../../src/modules/admin/route/consoleAiProviders.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { IdempotencyService } from '../../src/service/idempotencyService.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { AiProviderService } from '../../src/modules/ai/service/aiProviderService.js';
import { MemoryAiProviderRepo } from '../helpers/fakeAiProviderRepo.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { FakeUserRepo, FakeRateLimitRepo, FakeIdempotencyReceiptRepo } from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable, TxRunner } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';

async function build() {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);
  const userRepo = new FakeUserRepo();
  const auditRepo = new FakeAuditRepo();
  const repo = new MemoryAiProviderRepo();
  repo.seed({ code: 'a', sortOrder: 0 });
  repo.seed({ code: 'off', status: 'disabled', sortOrder: 1 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 11));
  const runner: TxRunner = (fn) => fn({} as Queryable);
  await app.register(consoleAiProvidersRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    consoleOrigin: ORIGIN,
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false),
    idempotencyService: new IdempotencyService(new FakeIdempotencyReceiptRepo(), runner),
    providers: new AiProviderService(repo),
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
  return { app, userRepo, auditRepo, repo, makeAdmin, writeHeaders, token };
}

const NEW_PROVIDER = {
  code: 'acme',
  name: { en: 'Acme', zh: 'Acme' },
  baseUrl: 'https://api.acme.com/v1/',
  models: [{ id: 'acme-1', default: true }],
  reason: '新增厂商',
};

describe('console AI providers routes', () => {
  it('未登录 401；非 admin 403', async () => {
    const b = await build();
    expect((await b.app.inject({ method: 'GET', url: '/api/admin/ai/providers' })).statusCode).toBe(401);
    const nobody = await b.userRepo.create('n@b.com', 'hash');
    const res = await b.app.inject({ method: 'GET', url: '/api/admin/ai/providers', headers: { authorization: `Bearer ${await b.token(nobody.id)}`, accept: 'application/json' } });
    expect(res.statusCode).toBe(403);
  });

  it('GET 返回全量（含停用）+ 审计', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const h = await b.writeHeaders(admin.id);
    const res = await b.app.inject({ method: 'GET', url: '/api/admin/ai/providers', headers: { authorization: h.authorization, accept: 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: Array<{ code: string }> }).items.map((i) => i.code)).toEqual(['a', 'off']);
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.providers.read')).toBe(true);
  });

  it('POST 新增：规整 baseUrl + 审计；重复 409；http 地址 422；缺 reason 422', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const ok = await b.app.inject({ method: 'POST', url: '/api/admin/ai/providers', headers: await b.writeHeaders(admin.id), payload: NEW_PROVIDER });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { provider: { baseUrl: string } }).provider.baseUrl).toBe('https://api.acme.com/v1');
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.provider.created' && e.targetId === 'acme')).toBe(true);

    const dup = await b.app.inject({ method: 'POST', url: '/api/admin/ai/providers', headers: await b.writeHeaders(admin.id), payload: NEW_PROVIDER });
    expect(dup.statusCode).toBe(409);

    const http = await b.app.inject({ method: 'POST', url: '/api/admin/ai/providers', headers: await b.writeHeaders(admin.id), payload: { ...NEW_PROVIDER, code: 'acme2', baseUrl: 'http://x.com/v1' } });
    expect(http.statusCode).toBe(422);

    const { reason: _r, ...noReason } = NEW_PROVIDER;
    const miss = await b.app.inject({ method: 'POST', url: '/api/admin/ai/providers', headers: await b.writeHeaders(admin.id), payload: { ...noReason, code: 'acme3' } });
    expect(miss.statusCode).toBe(422);
  });

  it('PATCH 停用 + 审计；未知 code 404；缺 CSRF 403', async () => {
    const b = await build();
    const admin = await b.makeAdmin();
    const res = await b.app.inject({ method: 'PATCH', url: '/api/admin/ai/providers/a', headers: await b.writeHeaders(admin.id), payload: { status: 'disabled', reason: '下线' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { provider: { status: string } }).provider.status).toBe('disabled');
    expect(b.auditRepo.events.some((e) => e.eventType === 'admin.ai.provider.updated' && e.targetId === 'a')).toBe(true);

    const miss = await b.app.inject({ method: 'PATCH', url: '/api/admin/ai/providers/nope', headers: await b.writeHeaders(admin.id), payload: { sortOrder: 1, reason: 'x' } });
    expect(miss.statusCode).toBe(404);

    const h = await b.writeHeaders(admin.id);
    const noCsrf = await b.app.inject({ method: 'PATCH', url: '/api/admin/ai/providers/a', headers: { authorization: h.authorization, origin: ORIGIN, 'idempotency-key': randomUUID(), 'content-type': 'application/json', accept: 'application/json' }, payload: { sortOrder: 2, reason: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
