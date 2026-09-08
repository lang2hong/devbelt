import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/testApp.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';
import { csrfCookieName } from '../../src/middleware/cookies.js';

describe('token audience separation', () => {
  it('rejects a console token on extension-only sync APIs', async () => {
    const t = await buildTestApp();
    const user = await t.repos.userRepo.create('aud@b.com', 'hash', undefined);
    const consoleToken = await t.tokenService.signAccessToken({
      userId: user.id,
      aud: 'console',
      scope: [...CONSOLE_SCOPES],
      sessionId: 'test-session',
      sessionVersion: 0,
    });

    const res = await t.app.inject({ method: 'GET', url: '/api/sync/state', headers: t.auth(consoleToken) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('TOKEN_AUDIENCE_FORBIDDEN');
    await t.close();
  });

  it('accepts both extension and console tokens on shared APIs (/api/me)', async () => {
    const t = await buildTestApp();
    const user = await t.repos.userRepo.create('shared@b.com', 'hash', undefined);
    const consoleToken = await t.tokenService.signAccessToken({
      userId: user.id,
      aud: 'console',
      scope: [...CONSOLE_SCOPES],
      sessionId: 'test-session',
      sessionVersion: 0,
    });
    const extToken = await t.tokenFor(user.id);

    const viaConsole = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(consoleToken) });
    expect(viaConsole.statusCode).toBe(200);

    const viaExt = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(extToken) });
    expect(viaExt.statusCode).toBe(200);
    await t.close();
  });

  it('rejects a correct-audience token missing the required scope', async () => {
    const t = await buildTestApp();
    const user = await t.repos.userRepo.create('scope@b.com', 'hash', undefined);
    // 正确 audience（extension），但 scope 为空 → 403 FORBIDDEN（/api/me 需 account）。
    const emptyScope = await t.tokenService.signAccessToken({
      userId: user.id,
      aud: 'extension',
      scope: [],
      sessionId: 'test-session',
      sessionVersion: 0,
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(emptyScope) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');

    // console audience 但只有 console scope（无 account）→ 同样 403。
    const consoleOnly = await t.tokenService.signAccessToken({
      userId: user.id,
      aud: 'console',
      scope: ['console'],
      sessionId: 'test-session',
      sessionVersion: 0,
    });
    const res2 = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(consoleOnly) });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().code).toBe('FORBIDDEN');
    await t.close();
  });

  it('enforces console-write CSRF/Origin on shared organization writes, extension unaffected', async () => {
    const t = await buildTestApp();
    const user = await t.repos.userRepo.create('orgw@b.com', 'hash', undefined);
    const consoleToken = await t.tokenService.signAccessToken({
      userId: user.id,
      aud: 'console',
      scope: [...CONSOLE_SCOPES],
      sessionId: 'test-session',
      sessionVersion: 0,
    });
    const boundCsrf = t.csrfService.issue('test-session');

    // console + 会话绑定 CSRF + Origin → 放行
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: {
        origin: 'http://localhost:5173',
        authorization: `Bearer ${consoleToken}`,
        'content-type': 'application/json',
        'x-csrf-token': boundCsrf,
        cookie: `${csrfCookieName()}=${boundCsrf}`,
      },
      payload: { name: 'Console Org' },
    });
    expect(ok.statusCode).toBe(201);

    // console 但缺 CSRF → 403（Origin 也取不到时仍 403）
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: { origin: 'http://localhost:5173', authorization: `Bearer ${consoleToken}`, 'content-type': 'application/json' },
      payload: { name: 'Console Org 2' },
    });
    expect(noCsrf.statusCode).toBe(403);

    // extension 纯 Bearer 不受影响
    const extToken = await t.tokenFor(user.id);
    const ext = await t.app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers: t.auth(extToken),
      payload: { name: 'Ext Org' },
    });
    expect(ext.statusCode).toBe(201);
    await t.close();
  });
});