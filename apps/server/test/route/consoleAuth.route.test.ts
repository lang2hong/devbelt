import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { consoleAuthRoutes } from '../../src/modules/auth/route/consoleAuth.js';
import { requestId } from '../../src/middleware/requestId.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';
import { ConsoleAuthService } from '../../src/modules/auth/service/consoleAuthService.js';
import { CsrfService } from '../../src/service/csrfService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { hashPassword } from '../../src/modules/auth/service/password.js';
import { csrfCookieName, refreshCookieName } from '../../src/middleware/cookies.js';
import { FakeUserRepo, FakeDeviceRepo, FakeRefreshTokenRepo, FakeRateLimitRepo } from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const ORIGIN = 'http://localhost:5173';
const DEVICE_KEY = 'web-key-000000000001';
const PASSWORD = 'correct-horse-battery';

async function buildApp(): Promise<{ app: FastifyInstance; userEmail: string }> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(requestId);

  const userRepo = new FakeUserRepo();
  const deviceRepo = new FakeDeviceRepo();
  const refreshTokenRepo = new FakeRefreshTokenRepo();
  const rateLimiter = new RateLimitService(new FakeRateLimitRepo(), false);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys: SigningKeys = { kid: 'test', privateKey, publicKeys: new Map([['test', publicKey]]) };
  const tokenService = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
  const consoleAuthService = new ConsoleAuthService(userRepo, deviceRepo, refreshTokenRepo, tokenService, rateLimiter, async (fn) => fn({} as Queryable));
  const csrfService = new CsrfService(Buffer.alloc(32, 5));
  const auditWriter = new AuditWriter(new FakeAuditRepo());

  await app.register(consoleAuthRoutes, {
    csrfService,
    rateLimiter,
    consoleAuthService,
    consoleOrigin: ORIGIN,
    auditWriter,
    refreshMaxAgeSeconds: 30 * 24 * 3600,
    register: async () => ({ ok: true }),
  });

  // 预置一个已验证邮箱、可登录的用户。
  const passwordHash = await hashPassword(PASSWORD);
  const user = await userRepo.create('user@b.com', passwordHash, 'Alice');
  await userRepo.markEmailVerified({} as Queryable, user.id, new Date());

  await app.ready();
  return { app, userEmail: 'user@b.com' };
}

function setCookies(res: any): string[] {
  const sc = res.headers['set-cookie'];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

function cookieValue(res: any, name: string): string | undefined {
  const header = setCookies(res).find((c: string) => c.startsWith(`${name}=`));
  if (!header) return undefined;
  return decodeURIComponent(header.split(';')[0].slice(name.length + 1));
}

describe('console auth routes', () => {
  it('registers without issuing a session', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/console/auth/register',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': 'nope' },
      payload: { email: 'new@b.com', password: 'a-long-password-123' },
    });
    // 匿名 CSRF 未通过 → 403
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('login issues refresh + session-bound csrf cookies and returns an access token', async () => {
    const { app } = await buildApp();

    const csrfRes = await app.inject({ method: 'GET', url: '/api/console/auth/csrf' });
    const anonCsrf = cookieValue(csrfRes, csrfCookieName())!;

    const login = await app.inject({
      method: 'POST',
      url: '/api/console/auth/login',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': anonCsrf,
        cookie: `${csrfCookieName()}=${anonCsrf}`,
      },
      payload: { email: 'user@b.com', password: PASSWORD, deviceKey: DEVICE_KEY, devicePlatform: 'web', deviceName: 'Web Console', clientVersion: '1.0.0' },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.user.email).toBe('user@b.com');

    const refresh = cookieValue(login, refreshCookieName());
    const sessionCsrf = cookieValue(login, csrfCookieName());
    expect(refresh).toBeTruthy();
    expect(sessionCsrf).toBeTruthy();
    expect(sessionCsrf).not.toBe(anonCsrf);
    // 刷新 cookie 生命周期对齐服务端 refresh token 有效期（而非 600s 默认）。
    const refreshCookieHeader = setCookies(login).find((c) => c.startsWith(`${refreshCookieName()}=`))!;
    expect(refreshCookieHeader).toContain('Max-Age=2592000');
    await app.close();
  });

  it('refresh rejects an anonymous csrf and rotates with the session-bound csrf', async () => {
    const { app } = await buildApp();
    const csrfRes = await app.inject({ method: 'GET', url: '/api/console/auth/csrf' });
    const anonCsrf = cookieValue(csrfRes, csrfCookieName())!;

    const login = await app.inject({
      method: 'POST',
      url: '/api/console/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': anonCsrf, cookie: `${csrfCookieName()}=${anonCsrf}` },
      payload: { email: 'user@b.com', password: PASSWORD, deviceKey: DEVICE_KEY, devicePlatform: 'web', deviceName: 'Web Console', clientVersion: '1.0.0' },
    });
    const refreshToken = cookieValue(login, refreshCookieName())!;
    const sessionCsrf = cookieValue(login, csrfCookieName())!;

    // 匿名 csrf（无 session 绑定）应被拒
    const bad = await app.inject({
      method: 'POST',
      url: '/api/console/auth/refresh',
      headers: { origin: ORIGIN, accept: 'application/json', 'x-csrf-token': anonCsrf, cookie: `${refreshCookieName()}=${refreshToken}; ${csrfCookieName()}=${anonCsrf}` },
    });
    expect(bad.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/console/auth/refresh',
      headers: { origin: ORIGIN, accept: 'application/json', 'x-csrf-token': sessionCsrf, cookie: `${refreshCookieName()}=${refreshToken}; ${csrfCookieName()}=${sessionCsrf}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTruthy();
    await app.close();
  });

  it('reload flow: csrf bootstrap after login issues a family-bound token that refresh accepts', async () => {
    const { app } = await buildApp();
    const csrfRes = await app.inject({ method: 'GET', url: '/api/console/auth/csrf' });
    const anonCsrf = cookieValue(csrfRes, csrfCookieName())!;
    const login = await app.inject({
      method: 'POST',
      url: '/api/console/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': anonCsrf, cookie: `${csrfCookieName()}=${anonCsrf}` },
      payload: { email: 'user@b.com', password: PASSWORD, deviceKey: DEVICE_KEY, devicePlatform: 'web', deviceName: 'Web Console', clientVersion: '1.0.0' },
    });
    const refreshToken = cookieValue(login, refreshCookieName())!;

    // 页面加载：带 refresh cookie 再签 csrf → 应得到绑定到该 family 的 token（而非匿名）。
    const bootstrap = await app.inject({
      method: 'GET',
      url: '/api/console/auth/csrf',
      headers: { cookie: `${refreshCookieName()}=${refreshToken}` },
    });
    const boundCsrf = cookieValue(bootstrap, csrfCookieName())!;

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/console/auth/refresh',
      headers: {
        origin: ORIGIN,
        accept: 'application/json',
        'x-csrf-token': boundCsrf,
        cookie: `${refreshCookieName()}=${refreshToken}; ${csrfCookieName()}=${boundCsrf}`,
      },
    });
    expect(refresh.statusCode).toBe(200);
    await app.close();
  });

  it('logout clears the refresh and csrf cookies', async () => {
    const { app } = await buildApp();
    const csrfRes = await app.inject({ method: 'GET', url: '/api/console/auth/csrf' });
    const anonCsrf = cookieValue(csrfRes, csrfCookieName())!;
    const login = await app.inject({
      method: 'POST',
      url: '/api/console/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': anonCsrf, cookie: `${csrfCookieName()}=${anonCsrf}` },
      payload: { email: 'user@b.com', password: PASSWORD, deviceKey: DEVICE_KEY, devicePlatform: 'web', deviceName: 'Web Console', clientVersion: '1.0.0' },
    });
    const refreshToken = cookieValue(login, refreshCookieName())!;
    const sessionCsrf = cookieValue(login, csrfCookieName())!;

    const logout = await app.inject({
      method: 'POST',
      url: '/api/console/auth/logout',
      headers: { origin: ORIGIN, accept: 'application/json', 'x-csrf-token': sessionCsrf, cookie: `${refreshCookieName()}=${refreshToken}; ${csrfCookieName()}=${sessionCsrf}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(setCookies(logout).some((c) => c.startsWith(`${refreshCookieName()}=`) && c.includes('Max-Age=0'))).toBe(true);
    await app.close();
  });
});