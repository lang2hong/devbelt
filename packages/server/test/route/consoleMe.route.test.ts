import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { consoleMeRoutes } from '../../src/route/consoleMe.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';
import {
  FakeUserRepo,
  FakePersonalPlanRepo,
  FakePersonalSubscriptionRepo,
  FakeMembershipRepo,
  FakeOrganizationRepo,
  FakeRateLimitRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';

const SESSION = 'test-session-0001';

async function buildApp(): Promise<{ app: FastifyInstance; tokenService: TokenService; csrfService: CsrfService; userRepo: FakeUserRepo }> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  await userRepo.create('me@b.com', 'hash', 'Alice');
  const personalSubscriptionRepo = new FakePersonalSubscriptionRepo();
  const personalPlanRepo = new FakePersonalPlanRepo();
  const membershipRepo = new FakeMembershipRepo(userRepo, new FakeOrganizationRepo());

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 6));

  await app.register(consoleMeRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    csrfService,
    auditWriter: new AuditWriter(new FakeAuditRepo()),
    rateLimiter: new RateLimitService(new FakeRateLimitRepo(), false),
    consoleOrigin: 'http://localhost:5173',
    userRepo,
    personalSubscriptionRepo,
    personalPlanRepo,
    membershipRepo,
  });

  await app.ready();
  return { app, tokenService, csrfService, userRepo };
}

async function consoleToken(tokenService: TokenService, userId: number): Promise<string> {
  return tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: SESSION, sessionVersion: 0 });
}

describe('console me routes', () => {
  it('GET /api/console/me returns the current user and platform flag', async () => {
    const { app, tokenService, userRepo } = await buildApp();
    const u = await userRepo.findByEmail('me@b.com');
    const token = await consoleToken(tokenService, u!.id);

    const res = await app.inject({ method: 'GET', url: '/api/console/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('me@b.com');
    expect(res.json().platformAdmin).toBe(false);
    expect(Array.isArray(res.json().organizations)).toBe(true);
    await app.close();
  });

  it('rejects an extension token on /api/console/me', async () => {
    const { app, tokenService, userRepo } = await buildApp();
    const u = await userRepo.findByEmail('me@b.com');
    const extToken = await tokenService.signAccessToken({ userId: u!.id, aud: 'extension', scope: ['account'], sessionId: SESSION, sessionVersion: 0 });

    const res = await app.inject({ method: 'GET', url: '/api/console/me', headers: { authorization: `Bearer ${extToken}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TOKEN_AUDIENCE_FORBIDDEN');
    await app.close();
  });

  it('PATCH /api/console/me updates displayName with a session-bound csrf token', async () => {
    const { app, tokenService, csrfService, userRepo } = await buildApp();
    const u = await userRepo.findByEmail('me@b.com');
    const token = await consoleToken(tokenService, u!.id);
    const boundCsrf = csrfService.issue(SESSION);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/console/me',
      headers: {
        origin: 'http://localhost:5173',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': boundCsrf,
        cookie: `${csrfCookieName()}=${boundCsrf}`,
      },
      payload: { displayName: '  Bob  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.displayName).toBe('Bob');

    const fresh = await userRepo.findById(u!.id);
    expect(fresh!.displayName).toBe('Bob');
    await app.close();
  });
});