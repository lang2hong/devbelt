import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 认证路由的 HTTP 层行为。
 *
 * 重点不是业务逻辑（authService 已有 374 行单测），而是此前完全没测过的
 * 那一层：schema 校验、解构位置、错误码。register/login 的解构写在 try
 * 之外，空 body 时会抛 TypeError 落到默认处理器 → 500 +
 * "Cannot destructure property 'email' of 'req.body' as it is undefined"。
 */

let t: TestApp;

beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

describe('POST /api/auth/register', () => {
  it('缺 body → 400 而非 500', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register' });
    expect(res.statusCode).toBe(400);
    // 不得回显 "Cannot destructure property ..." 这类内部细节
    expect(res.json().message).not.toContain('destructure');
  });

  it('空对象 body → 400（缺 required 字段）', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('password 为对象 → 400（无法强转成 string）', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'a@b.com', password: { nested: 'x' } },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * Fastify 的 ajv 默认开 `coerceTypes`，标量会被强转（数字 → 字符串、
   * 字符串 → 整数）。这是 querystring 里 `?limit=50` 能通过 integer 校验
   * 的同一机制，关掉会让所有 query/params 校验失效，因此是刻意保留的行为。
   * 这条用例把它钉住，避免以后有人误以为 schema 会拒绝数字密码。
   */
  it('标量类型被强转而非拒绝（coerceTypes 的既定行为）', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'coerce@example.com', password: 12345678 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('合法载荷 → 201 且不泄漏 passwordHash', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'new@example.com', password: 'longenough1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('短密码 → 400（服务层 ValidationError 经全局 handler 映射）', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'a@b.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('缺 body → 400', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login' });
    expect(res.statusCode).toBe(400);
  });

  it('未知邮箱 → 401 且不区分「无此用户」与「密码错」', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
  });
});

describe('POST /api/auth/refresh', () => {
  it('缺 refreshToken → 400', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('未知 refreshToken → 401', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: 'bogus' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('禁用用户不得续期 → 403 USER_DISABLED，且全部会话被撤销', async () => {
    const reg = await t.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'ban@example.com', password: 'longenough1' },
    });
    const { refreshToken, userId } = reg.json();
    await t.repos.userRepo.updateStatus(userId, 'disabled');

    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/refresh', payload: { refreshToken },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('USER_DISABLED');

    const active = (await t.repos.refreshTokenRepo.listActiveForUser(userId, new Date())).length;
    expect(active).toBe(0);
  });
});

describe('GET /api/devices', () => {
  it('无 token → 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/devices' });
    expect(res.statusCode).toBe(401);
  });

  it('有 token → 200', async () => {
    const { token } = await t.makeUser();
    const res = await t.app.inject({
      method: 'GET', url: '/api/devices', headers: t.auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().devices)).toBe(true);
  });
});

describe('DELETE /api/devices/:deviceId', () => {
  it('free 用户撤销 → 403（Pro 功能）', async () => {
    const u = await t.makeUser();
    await t.repos.deviceRepo.upsert({ userId: u.id, deviceId: 'dev-1' } as any);
    const res = await t.app.inject({
      method: 'DELETE', url: '/api/devices/dev-1', headers: t.auth(u.token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PRO_FEATURE_REQUIRED');
  });

  it('pro 用户撤销 → 200', async () => {
    const u = await t.makeUser();
    await t.grantPlan(u.id, 'pro');
    await t.repos.deviceRepo.upsert({ userId: u.id, deviceId: 'dev-1' } as any);
    const res = await t.app.inject({
      method: 'DELETE', url: '/api/devices/dev-1', headers: t.auth(u.token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('未匹配路由', () => {
  it('404 不回显路由探测信息', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'not found', code: 'NOT_FOUND' });
  });
});
