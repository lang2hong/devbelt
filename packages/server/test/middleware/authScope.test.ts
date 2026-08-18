import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { authScope } from '../../src/middleware/requireAuth.js';
import { requireRole } from '../../src/middleware/requireRole.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 中间件是安全边界，此前零覆盖。
 *
 * 这里用最小 Fastify 实例直接测中间件本身（不经业务路由），覆盖
 * token 缺失/过期/错签、封装作用域是否正确隔离、以及 getUser 注入后的
 * status/role 判定。
 */

const SECRET = 'middleware-test-secret';

async function minimalApp(opts: {
  getUser?: (id: number) => Promise<{ status: string; role: string } | undefined>;
  roles?: Array<'user' | 'admin'>;
}) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(jwt, { secret: SECRET, sign: { expiresIn: '15m' } });

  // 父作用域的公开路由：用来验证 onRequest 钩子不会上浮影响它
  app.get('/public', async () => ({ ok: true }));

  if (opts.roles) {
    await app.register(requireRole(opts.roles), {
      getUser: opts.getUser,
      routes: async (child) => { child.get('/guarded', async () => ({ ok: true })); },
    });
  } else {
    await app.register(authScope, {
      getUser: opts.getUser,
      routes: async (child) => {
        child.get('/guarded', async (req) => ({ ok: true, sub: req.user.sub }));
      },
    });
  }
  await app.ready();
  return app;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('authScope', () => {
  it('无 Authorization 头 → 401', async () => {
    const app = await minimalApp({});
    expect((await app.inject({ method: 'GET', url: '/guarded' })).statusCode).toBe(401);
    await app.close();
  });

  it('格式错误的头 → 401', async () => {
    const app = await minimalApp({});
    const res = await app.inject({
      method: 'GET', url: '/guarded', headers: { authorization: 'NotBearer xyz' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('错误签名 → 401', async () => {
    const app = await minimalApp({});
    const other = Fastify();
    await other.register(jwt, { secret: 'a-different-secret' });
    await other.ready();
    const forged = other.jwt.sign({ sub: 1, role: 'user' });
    const res = await app.inject({ method: 'GET', url: '/guarded', headers: bearer(forged) });
    expect(res.statusCode).toBe(401);
    await other.close();
    await app.close();
  });

  it('过期 token → 401', async () => {
    const app = await minimalApp({});
    const expired = app.jwt.sign({ sub: 1, role: 'user' }, { expiresIn: '-1s' });
    const res = await app.inject({ method: 'GET', url: '/guarded', headers: bearer(expired) });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401 响应不区分失败原因（不给攻击者反馈）', async () => {
    const app = await minimalApp({});
    const expired = app.jwt.sign({ sub: 1, role: 'user' }, { expiresIn: '-1s' });
    const a = await app.inject({ method: 'GET', url: '/guarded' });
    const b = await app.inject({ method: 'GET', url: '/guarded', headers: bearer(expired) });
    expect(a.json()).toEqual(b.json());
    await app.close();
  });

  it('有效 token → 放行并注入 req.user', async () => {
    const app = await minimalApp({});
    const token = app.jwt.sign({ sub: 42, role: 'user' });
    const res = await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().sub).toBe(42);
    await app.close();
  });

  /**
   * 封装语义回归：onRequest 只作用于当前作用域及子作用域。
   * 父作用域的 /public 不能被子作用域的钩子波及。
   */
  it('父作用域的公开路由不受影响', async () => {
    const app = await minimalApp({});
    expect((await app.inject({ method: 'GET', url: '/public' })).statusCode).toBe(200);
    await app.close();
  });

  describe('注入 getUser 后', () => {
    it('active 用户 → 放行', async () => {
      const app = await minimalApp({ getUser: async () => ({ status: 'active', role: 'user' }) });
      const token = app.jwt.sign({ sub: 1, role: 'user' });
      expect((await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) })).statusCode).toBe(200);
      await app.close();
    });

    it('disabled 用户 → 403 USER_DISABLED', async () => {
      const app = await minimalApp({ getUser: async () => ({ status: 'disabled', role: 'user' }) });
      const token = app.jwt.sign({ sub: 1, role: 'user' });
      const res = await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('USER_DISABLED');
      await app.close();
    });

    it('用户已删除 → 401', async () => {
      const app = await minimalApp({ getUser: async () => undefined });
      const token = app.jwt.sign({ sub: 1, role: 'user' });
      expect((await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) })).statusCode).toBe(401);
      await app.close();
    });

    it('getUser 每个请求恰好被调用一次（不重复查库）', async () => {
      let called = 0;
      const app = await minimalApp({
        getUser: async () => { called++; return { status: 'active', role: 'user' }; },
      });
      const token = app.jwt.sign({ sub: 7, role: 'user' });
      await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) });
      expect(called).toBe(1);
      await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) });
      expect(called).toBe(2);
      await app.close();
    });

    it('getUser 拿到的是 token 里的 sub', async () => {
      const seen: number[] = [];
      const app = await minimalApp({
        getUser: async (id) => { seen.push(id); return { status: 'active', role: 'user' }; },
      });
      await app.inject({
        method: 'GET', url: '/guarded', headers: bearer(app.jwt.sign({ sub: 99, role: 'user' })),
      });
      expect(seen).toEqual([99]);
      await app.close();
    });
  });
});

describe('requireRole', () => {
  it('无 token → 401', async () => {
    const app = await minimalApp({ roles: ['admin'] });
    expect((await app.inject({ method: 'GET', url: '/guarded' })).statusCode).toBe(401);
    await app.close();
  });

  it('无 getUser 时退回 token 声明（兼容）', async () => {
    const app = await minimalApp({ roles: ['admin'] });
    const admin = app.jwt.sign({ sub: 1, role: 'admin' });
    const user = app.jwt.sign({ sub: 2, role: 'user' });
    expect((await app.inject({ method: 'GET', url: '/guarded', headers: bearer(admin) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/guarded', headers: bearer(user) })).statusCode).toBe(403);
    await app.close();
  });

  it('有 getUser 时以 DB role 为准，token 声明不作数', async () => {
    const app = await minimalApp({
      roles: ['admin'],
      getUser: async () => ({ status: 'active', role: 'user' }),
    });
    // token 说 admin，DB 说 user → 必须 403
    const forged = app.jwt.sign({ sub: 1, role: 'admin' });
    expect((await app.inject({ method: 'GET', url: '/guarded', headers: bearer(forged) })).statusCode).toBe(403);
    await app.close();
  });

  it('DB 里是 admin 但 token 声明是 user → 放行（DB 优先）', async () => {
    const app = await minimalApp({
      roles: ['admin'],
      getUser: async () => ({ status: 'active', role: 'admin' }),
    });
    const stale = app.jwt.sign({ sub: 1, role: 'user' });
    expect((await app.inject({ method: 'GET', url: '/guarded', headers: bearer(stale) })).statusCode).toBe(200);
    await app.close();
  });

  it('disabled 的 admin → 403 USER_DISABLED（先于角色判定）', async () => {
    const app = await minimalApp({
      roles: ['admin'],
      getUser: async () => ({ status: 'disabled', role: 'admin' }),
    });
    const token = app.jwt.sign({ sub: 1, role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('USER_DISABLED');
    await app.close();
  });

  it('多角色白名单：任一匹配即放行', async () => {
    const app = await minimalApp({
      roles: ['user', 'admin'],
      getUser: async () => ({ status: 'active', role: 'user' }),
    });
    const token = app.jwt.sign({ sub: 1, role: 'user' });
    expect((await app.inject({ method: 'GET', url: '/guarded', headers: bearer(token) })).statusCode).toBe(200);
    await app.close();
  });
});

describe('作用域隔离（真实装配）', () => {
  let t: TestApp;
  beforeEach(async () => { t = await buildTestApp(); });
  afterEach(async () => { await t.close(); });

  it('/health 与公开的 auth 端点不需要 token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    // login 缺 body 时是 400（schema），而不是 401 —— 证明它没被 authScope 覆盖
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login' })).statusCode).toBe(400);
  });

  it('各已认证端点一致返回 401', async () => {
    for (const [method, url] of [
      ['GET', '/api/me'], ['GET', '/api/sync'], ['GET', '/api/sync/versions?section=groups'],
      ['POST', '/api/usage'], ['GET', '/api/auth/sessions'], ['GET', '/admin/plans'],
    ] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
