import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/testApp.js';
import { CONSOLE_SCOPES } from '../../src/domain/enums.js';

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

    const res = await t.app.inject({ method: 'GET', url: '/api/db/sync/state', headers: t.auth(consoleToken) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('TOKEN_AUDIENCE_FORBIDDEN');
    await t.close();
  });

  it('accepts both extension and console tokens on shared APIs (/api/db/me)', async () => {
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

    const viaConsole = await t.app.inject({ method: 'GET', url: '/api/db/me', headers: t.auth(consoleToken) });
    expect(viaConsole.statusCode).toBe(200);

    const viaExt = await t.app.inject({ method: 'GET', url: '/api/db/me', headers: t.auth(extToken) });
    expect(viaExt.statusCode).toBe(200);
    await t.close();
  });

  it('rejects a correct-audience token missing the required scope', async () => {
    const t = await buildTestApp();
    const user = await t.repos.userRepo.create('scope@b.com', 'hash', undefined);
    // 正确 audience（extension），但 scope 为空 → 403 FORBIDDEN（/api/db/me 需 account）。
    const emptyScope = await t.tokenService.signAccessToken({
      userId: user.id,
      aud: 'extension',
      scope: [],
      sessionId: 'test-session',
      sessionVersion: 0,
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/db/me', headers: t.auth(emptyScope) });
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
    const res2 = await t.app.inject({ method: 'GET', url: '/api/db/me', headers: t.auth(consoleOnly) });
    expect(res2.statusCode).toBe(403);
    expect(res2.json().code).toBe('FORBIDDEN');
    await t.close();
  });
});