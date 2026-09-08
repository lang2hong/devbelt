import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { linkFlowRoutes } from '../../src/route/linkFlows.js';
import { consoleAuthRoutes } from '../../src/route/consoleAuth.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { LinkFlowService } from '../../src/service/linkFlowService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { linkFlowCookieName, csrfCookieName } from '../../src/middleware/cookies.js';
import { FakeMailFlowRepo, FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import { FakeEmailVerificationTokenRepo, FakeUserRepo, FakeRateLimitRepo } from '../helpers/fakeRepos.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const TOKEN = 'C'.repeat(43);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const mailFlow = new FakeMailFlowRepo();
  const tokenRepo = new FakeEmailVerificationTokenRepo();
  const userRepo = new FakeUserRepo();
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
  const linkFlowService = new LinkFlowService(mailFlow, tokenRepo, userRepo, async (fn) => fn({} as Queryable), rateLimiter);
  const csrfService = new CsrfService(Buffer.alloc(32, 7));
  const auditWriter = new AuditWriter(new FakeAuditRepo());

  await app.register(linkFlowRoutes, {
    linkFlowService,
    csrfService,
    auditWriter,
    consoleOrigin: ORIGIN,
    resendVerification: async () => ({ ok: true }),
  });
  await app.register(consoleAuthRoutes, {
    csrfService,
    rateLimiter,
    consoleAuthService: {} as any,
    consoleOrigin: ORIGIN,
    auditWriter,
    refreshMaxAgeSeconds: 30 * 24 * 3600,
    register: async () => ({ ok: true }),
  });
  await app.ready();
  return app;
}

function setCookies(res: any): string[] {
  const sc = res.headers['set-cookie'];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

function cookieValueOf(res: any, name: string): string | undefined {
  const header = setCookies(res).find((c: string) => c.startsWith(`${name}=`));
  if (!header) return undefined;
  return decodeURIComponent(header.split(';')[0].slice(name.length + 1));
}

async function fetchCsrf(app: FastifyInstance): Promise<{ token: string; cookie: string }> {
  const res = await app.inject({ method: 'GET', url: '/api/console/auth/csrf' });
  const token = cookieValueOf(res, csrfCookieName())!;
  return { token, cookie: `${csrfCookieName()}=${token}` };
}

describe('link-flow / csrf routes', () => {
  it('rejects claim without a matching Origin', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/public/link-flows', payload: { type: 'verify-email', token: TOKEN } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await app.close();
  });

  it('rejects claim without Accept: application/json', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { type: 'verify-email', token: TOKEN },
    });
    expect(res.statusCode).toBe(406);
    expect(res.json().error.code).toBe('NOT_ACCEPTABLE');
    await app.close();
  });

  it('rejects claim with a non-JSON Content-Type as 415', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows',
      headers: { origin: ORIGIN, 'content-type': 'text/plain', accept: 'application/json' },
      payload: 'just text',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    await app.close();
  });

  it('maps malformed JSON body to a 400 console envelope', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json' },
      payload: '{"type": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'VALIDATION_FAILED', message: 'Bad request' });
    await app.close();
  });

  it('maps schema-validation failure to the 422 console envelope', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json' },
      payload: { type: 'verify-email', token: 'not-a-43-char-token' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({ code: 'VALIDATION_FAILED', message: 'validation failed' });
    await app.close();
  });

  it('claims a token and issues a link-flow cookie', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json' },
      payload: { type: 'verify-email', token: TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(cookieValueOf(res, linkFlowCookieName())).toBeTruthy();
    await app.close();
  });

  it('rejects verify-email without a link-flow cookie', async () => {
    const app = await buildApp();
    const csrf = await fetchCsrf(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows/verify-email',
      headers: { origin: ORIGIN, accept: 'application/json', 'x-csrf-token': csrf.token, cookie: csrf.cookie },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('EMAIL_VERIFICATION_INVALID');
    await app.close();
  });

  it('rejects verify-email without anonymous CSRF', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows/verify-email',
      headers: { origin: ORIGIN, accept: 'application/json' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await app.close();
  });

  it('verifies-email via cookie claim → consume (unresolvable token → invalid)', async () => {
    const app = await buildApp();
    const claim = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json' },
      payload: { type: 'verify-email', token: TOKEN },
    });
    const nonce = cookieValueOf(claim, linkFlowCookieName())!;
    const csrf = await fetchCsrf(app);
    const verify = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows/verify-email',
      headers: {
        origin: ORIGIN,
        accept: 'application/json',
        'x-csrf-token': csrf.token,
        cookie: `${linkFlowCookieName()}=${nonce}; ${csrf.cookie}`,
      },
    });
    expect(verify.statusCode).toBe(401);
    expect(verify.json().error.code).toBe('EMAIL_VERIFICATION_INVALID');
    await app.close();
  });

  it('issues a csrf cookie and gates resend on double-submit', async () => {
    const app = await buildApp();

    const csrf = await app.inject({ method: 'GET', url: '/api/console/auth/csrf' });
    expect(csrf.statusCode).toBe(204);
    const csrfToken = cookieValueOf(csrf, csrfCookieName())!;
    expect(csrfToken).toBeTruthy();

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows/resend-verification',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json' },
      payload: { email: 'x@b.com' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/public/link-flows/resend-verification',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': csrfToken,
        cookie: `${csrfCookieName()}=${csrfToken}`,
      },
      payload: { email: 'x@b.com' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    await app.close();
  });
});