import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * access token 的吊销。
 *
 * ## 原先的缺口
 *
 * 登出、改密、踢设备、refresh token 重用检测 —— 这四件事都只撤销 refresh token。
 * 已经发出去的 access token 在有效期内（默认 15 分钟）照样能用。也就是说所有
 * 「立即下线」在实现层面都是「15 分钟后下线」，而这恰恰是最需要即时性的场景：
 * 用户发现设备丢了，点了踢下线，实际上小偷还能再操作一刻钟。
 *
 * ## 修复方式
 *
 * 不引入 jti 黑名单。access token 里的 `sid` 就是签发它的那条 refresh token 的
 * 行 id，而那一行的 `revoked_time` 已经被上述四个操作维护着 —— 直接查即可。
 * 代价是每个已认证请求多一次主键查询，与既有的 getUser 查询同级。
 */

let t: TestApp;
beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

describe('会话撤销后 access token 立即失效', () => {
  it('撤销会话 → 原 access token 拿到 401 SESSION_REVOKED', async () => {
    const u = await t.makeUser();

    // 撤销前正常可用
    const before = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(u.token) });
    expect(before.statusCode).toBe(200);

    await t.repos.refreshTokenRepo.revoke(u.sid);

    const after = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(u.token) });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('SESSION_REVOKED');
  });

  it('登出后原 access token 立即不可用（不必等 15 分钟过期）', async () => {
    const reg = await t.services.authService.register('logout-me@example.com', 'password123');
    const headers = { authorization: `Bearer ${reg.accessToken}` };

    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(200);

    await t.app.inject({
      method: 'POST', url: '/api/auth/logout',
      payload: { refreshToken: reg.refreshToken }, headers,
    });

    const after = await t.app.inject({ method: 'GET', url: '/api/me', headers });
    expect(after.statusCode).toBe(401);
  });

  /**
   * 改密的语义是「把其他人踢下去」。改完之后旧 access token 还能用的话，
   * 密码泄露后的补救措施就形同虚设。
   */
  it('改密后所有旧 access token 立即失效', async () => {
    const reg = await t.services.authService.register('chpw@example.com', 'password123');
    const headers = { authorization: `Bearer ${reg.accessToken}` };

    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(200);

    await t.services.authService.changePassword(reg.user.id, 'password123', 'newpassword456');

    const after = await t.app.inject({ method: 'GET', url: '/api/me', headers });
    expect(after.statusCode).toBe(401);
  });

  it('refresh token 重用检测撤销全部会话后，各设备的 access token 一并失效', async () => {
    const a = await t.services.authService.register('reuse@example.com', 'password123', {
      deviceId: 'dev-a',
    });
    const headersA = { authorization: `Bearer ${a.accessToken}` };
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: headersA })).statusCode).toBe(200);

    // 用同一个 refresh token 连刷两次：第二次触发重用检测 → revokeAllForUser
    await t.services.authService.refresh(a.refreshToken);
    await expect(t.services.authService.refresh(a.refreshToken)).rejects.toThrow();

    const after = await t.app.inject({ method: 'GET', url: '/api/me', headers: headersA });
    expect(after.statusCode).toBe(401);
  });

  it('撤销一个会话不影响同用户的其他会话', async () => {
    const u1 = await t.makeUser({ email: 'multi@example.com' });
    // 同一用户的第二条会话
    const s2 = await t.repos.refreshTokenRepo.create({
      userId: u1.id,
      tokenHash: 'hash-second',
      expiresTime: new Date(Date.now() + 86400_000),
    } as any);
    const token2 = t.tokenFor(u1.id, { sid: s2.id });

    await t.repos.refreshTokenRepo.revoke(u1.sid);

    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(u1.token) })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(token2) })).statusCode).toBe(200);
  });
});

describe('sid 本身的校验', () => {
  it('sid 指向不存在的会话 → 401', async () => {
    const u = await t.makeUser();
    const bogus = t.tokenFor(u.id, { sid: 999_999 });
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(bogus) });
    expect(res.statusCode).toBe(401);
  });

  /**
   * 拿别人的有效 sid 拼一个自己的 token —— 若不校验归属，被撤销的用户只要
   * 借一个别人的活跃 sid 就能继续用。
   */
  it('sid 属于其他用户 → 401', async () => {
    const victim = await t.makeUser({ email: 'victim@example.com' });
    const attacker = await t.makeUser({ email: 'attacker@example.com' });
    await t.repos.refreshTokenRepo.revoke(attacker.sid);

    const borrowed = t.tokenFor(attacker.id, { sid: victim.sid });
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(borrowed) });
    expect(res.statusCode).toBe(401);
  });

  it('无 sid 的旧版 token → 401（不留绕过吊销的后门）', async () => {
    const u = await t.makeUser();
    const legacy = t.app.jwt.sign({ sub: u.id, role: 'user', plan: 'free' });
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(legacy) });
    expect(res.statusCode).toBe(401);
  });
});

describe('admin 路由同样受会话撤销约束', () => {
  it('管理员会话被撤销后 /admin/* 立即 401', async () => {
    const admin = await t.makeUser({ role: 'admin' });
    expect((await t.app.inject({
      method: 'GET', url: '/admin/plans', headers: t.auth(admin.token),
    })).statusCode).toBe(200);

    await t.repos.refreshTokenRepo.revoke(admin.sid);

    const after = await t.app.inject({
      method: 'GET', url: '/admin/plans', headers: t.auth(admin.token),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('SESSION_REVOKED');
  });

  it('管理员的 sid 指向他人会话 → 401（不是 403）', async () => {
    const admin = await t.makeUser({ role: 'admin' });
    const other = await t.makeUser({ email: 'other@example.com' });
    const borrowed = t.tokenFor(admin.id, { role: 'admin', sid: other.sid });
    const res = await t.app.inject({ method: 'GET', url: '/admin/plans', headers: t.auth(borrowed) });
    expect(res.statusCode).toBe(401);
  });
});

describe('同步与用量路由也覆盖', () => {
  it('会话撤销后 GET /api/sync 401', async () => {
    const u = await t.makeUser();
    await t.repos.refreshTokenRepo.revoke(u.sid);
    const res = await t.app.inject({ method: 'GET', url: '/api/sync', headers: t.auth(u.token) });
    expect(res.statusCode).toBe(401);
  });

  it('会话撤销后 PUT /api/sync 401（写入路径不能漏）', async () => {
    const u = await t.makeUser();
    await t.repos.refreshTokenRepo.revoke(u.sid);
    const res = await t.app.inject({
      method: 'PUT', url: '/api/sync', headers: t.auth(u.token),
      payload: { section: 'connections', encryptedData: '{}', baseVersion: 0 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('会话撤销后 POST /api/usage 401', async () => {
    const u = await t.makeUser();
    await t.repos.refreshTokenRepo.revoke(u.sid);
    const res = await t.app.inject({
      method: 'POST', url: '/api/usage', headers: t.auth(u.token),
      payload: { connectionOpens: 1, queryExecutes: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * 会话自然过期。
 *
 * `getSession` 一直把 `expiresTime` 取回来，中间件却只判 `revokedTime` ——
 * 一条「已过期但从未被撤销」的会话行仍然会为 access token 背书。
 *
 * 当前参数下（access 15m < refresh 30d）不可直接利用，但那是参数凑巧而非设计
 * 保证：把 access TTL 调大、或把 refresh TTL 调小，这条路径立刻可用，且原来
 * 没有任何测试覆盖它。
 */
describe('会话自然过期后 access token 失效', () => {
  it('过期但未撤销的会话 → 401 SESSION_EXPIRED', async () => {
    const u = await t.makeUser();
    const session = t.repos.refreshTokenRepo.tokens.get(u.sid)!;
    // 只改过期时间，revokedTime 保持 null
    session.expiresTime = new Date(Date.now() - 1000);

    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(u.token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('SESSION_EXPIRED');
  });

  it('admin 路由同样拒绝已过期会话', async () => {
    const u = await t.makeUser({ role: 'admin' });
    t.repos.refreshTokenRepo.tokens.get(u.sid)!.expiresTime = new Date(Date.now() - 1000);

    const res = await t.app.inject({
      method: 'GET', url: '/admin/users?limit=10&offset=0', headers: t.auth(u.token),
    });
    expect(res.statusCode).toBe(401);
  });

  it('同步路由同样拒绝', async () => {
    const u = await t.makeUser();
    t.repos.refreshTokenRepo.tokens.get(u.sid)!.expiresTime = new Date(Date.now() - 1000);

    const res = await t.app.inject({ method: 'GET', url: '/api/sync', headers: t.auth(u.token) });
    expect(res.statusCode).toBe(401);
  });

  it('未过期的会话不受影响（不误伤正常请求）', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(u.token) });
    expect(res.statusCode).toBe(200);
  });

  /**
   * 不持有 refresh token 的客户端也必须能真正登出。
   *
   * 管理后台就是这样一个客户端：它只把 access token 存进 localStorage
   * （refresh token 放进浏览器存储没有意义 —— 一个能读 localStorage 的 XSS
   * 会把两个都拿走，只是把 15 分钟的窗口扩成 90 天）。如果登出接口硬要
   * refreshToken 字段，后台的"退出"就只能停留在清空前端状态，服务端会话
   * 仍然有效直到自然过期。共享电脑上这等于没登出。
   *
   * sid 本身就是权威判据（见 AuthService.logout），所以 refreshToken 该是可选的。
   */
  it('登出可以不带 refreshToken：仅凭 sid 撤销当前会话', async () => {
    const u = await t.makeUser();
    const headers = t.auth(u.token);

    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(res.statusCode).toBe(200);

    expect(t.repos.refreshTokenRepo.tokens.get(u.sid)!.revokedTime).toBeInstanceOf(Date);
    expect((await t.app.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(401);
  });

  it('登出带空 body 也可以（后台 fetch 不发 body）', async () => {
    const u = await t.makeUser();
    const headers = t.auth(u.token);
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/logout', headers, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(t.repos.refreshTokenRepo.tokens.get(u.sid)!.revokedTime).toBeInstanceOf(Date);
  });

  it('登出仍拒绝空字符串 refreshToken（明显是客户端 bug，不该静默当作没传）', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/logout', headers: t.auth(u.token),
      payload: { refreshToken: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('撤销优先于过期报告（两者同时成立时报 SESSION_REVOKED）', async () => {
    const u = await t.makeUser();
    const s = t.repos.refreshTokenRepo.tokens.get(u.sid)!;
    s.expiresTime = new Date(Date.now() - 1000);
    s.revokedTime = new Date(Date.now() - 2000);

    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(u.token) });
    expect(res.json().code).toBe('SESSION_REVOKED');
  });
});
