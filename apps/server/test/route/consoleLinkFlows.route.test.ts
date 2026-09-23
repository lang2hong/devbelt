import Fastify from 'fastify';
import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { consoleLinkFlowRoutes } from '../../src/modules/auth/route/consoleLinkFlows.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { LinkFlowService } from '../../src/modules/auth/service/linkFlowService.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { csrfCookieName, linkFlowCookieName } from '../../src/middleware/cookies.js';
import { FakeMailFlowRepo, FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import {
  FakeUserRepo,
  FakeEmailVerificationTokenRepo,
  FakeRateLimitRepo,
  FakeSyncResetTokenRepo,
} from '../helpers/fakeRepos.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const SESSION = 'test-session-accept';

interface BuildOpts {
  serviceOverride?: unknown;
  createSyncResetHandoff?: (nonce: string, userId: number) => Promise<{ openUri: string; expiresTime: string }>;
  rateLimit?: boolean;
}

async function build(opts: BuildOpts = {}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const mailFlowRepo = new FakeMailFlowRepo();
  const tokenRepo = new FakeEmailVerificationTokenRepo();
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), opts.rateLimit === true);
  const realService = new LinkFlowService(
    mailFlowRepo, tokenRepo, new FakeSyncResetTokenRepo(), userRepo,
    async (fn) => fn({} as Queryable), rateLimiter,
  );
  const linkFlowService = (opts.serviceOverride ?? realService) as LinkFlowService;
  const auditRepo = new FakeAuditRepo();

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const csrfService = new CsrfService(Buffer.alloc(32, 7));

  await app.register(consoleLinkFlowRoutes, {
    tokenService,
    getUser: async (id) => userRepo.findById(id),
    getSessionActive: async () => true,
    linkFlowService,
    csrfService,
    auditWriter: new AuditWriter(auditRepo),
    rateLimiter,
    consoleOrigin: ORIGIN,
    createSyncResetHandoff: opts.createSyncResetHandoff ?? (async () => ({ openUri: 'vscode://devbelt.sync/reset-after-loss?handoffTicket=test', expiresTime: new Date().toISOString() })),
  });
  await app.ready();
  return { app, tokenService, csrfService, userRepo, linkFlowService, auditRepo, mailFlowRepo };
}

function consoleToken(tokenService: TokenService, userId: number): Promise<string> {
  return tokenService.signAccessToken({ userId, aud: 'console', scope: [...CONSOLE_SCOPES], sessionId: SESSION, sessionVersion: 0 });
}

function setCookies(res: any): string[] {
  const sc = res.headers['set-cookie'];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

function headersFor(nonce: string | undefined, token: string, csrf: string): Record<string, string> {
  const cookie = `${csrfCookieName()}=${csrf}` + (nonce ? `; ${linkFlowCookieName()}=${nonce}` : '');
  return { origin: ORIGIN, authorization: `Bearer ${token}`, accept: 'application/json', 'x-csrf-token': csrf, cookie };
}

describe('console link-flow create-sync-reset-handoff route', () => {
  it('returns openUri for a console session with CSRF + mail-flow cookie', async () => {
    const b = await build({
      createSyncResetHandoff: async () => ({ openUri: 'vscode://devbelt.sync/reset-after-loss?handoffTicket=abc', expiresTime: '2026-09-09T00:00:00.000Z' }),
    });
    const user = await b.userRepo.create('sr@b.com', 'hash', 'S');
    await b.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/create-sync-reset-handoff',
      headers: headersFor('N'.repeat(43), token, csrf),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().openUri).toBe('vscode://devbelt.sync/reset-after-loss?handoffTicket=abc');
    expect(res.json().expiresTime).toBe('2026-09-09T00:00:00.000Z');
    await b.app.close();
  });

  it('rejects a missing cookie with 400 and clears the cookie', async () => {
    const b = await build();
    const user = await b.userRepo.create('sr-missing@b.com', 'hash', 'M');
    await b.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/create-sync-reset-handoff',
      headers: headersFor(undefined, token, csrf),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SYNC_RESET_HANDOFF_INVALID');
    const cleared = setCookies(res).some((c) => c.startsWith(`${linkFlowCookieName()}=`) && c.includes('Max-Age=0'));
    expect(cleared).toBe(true);
    await b.app.close();
  });

  it('rejects a request without CSRF/origin with 403 FORBIDDEN', async () => {
    const b = await build();
    const user = await b.userRepo.create('sr-csrf@b.com', 'hash', 'C');
    await b.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
    const token = await consoleToken(b.tokenService, user.id);

    const res = await b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/create-sync-reset-handoff',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await b.app.close();
  });

  it('rate-limits to 3 per 15min per session (429 on 4th attempt)', async () => {
    const b = await build({ rateLimit: true });
    const user = await b.userRepo.create('sr-rl@b.com', 'hash', 'R');
    await b.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
    const token = await consoleToken(b.tokenService, user.id);
    const csrf = b.csrfService.issue(SESSION);

    const post = () => b.app.inject({
      method: 'POST',
      url: '/api/console/link-flows/create-sync-reset-handoff',
      headers: headersFor(undefined, token, csrf),
      payload: {},
    });
    for (let i = 0; i < 3; i++) {
      const res = await post();
      expect(res.statusCode).toBe(400); // 缺 cookie，但限流计数已发生
    }
    const res = await post();
    expect(res.statusCode).toBe(429);
    await b.app.close();
  });
});