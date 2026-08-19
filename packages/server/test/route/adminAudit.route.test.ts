import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 管理端留痕的 HTTP 层。
 *
 * service 层测的是「留了什么」，这里测的是「操作者是谁」—— 而这一点只有走
 * 完整请求链路才验证得到：actor 必须来自 requireRole 复核过的 `req.user.sub`，
 * 而不是请求体里的某个字段。如果哪天有人图方便改成从 body 取 actorId，
 * 审计就变成了「攻击者自己填的名字」，比没有审计更糟。
 */
let t: TestApp;
let admin: { id: number; token: string; sid: number };

beforeEach(async () => {
  t = await buildTestApp();
  admin = await t.makeUser({ role: 'admin', email: 'root@example.com' });
});
afterEach(async () => { await t.close(); });

describe('留痕的操作者取自认证身份', () => {
  it('PATCH /admin/users/:id 记下真实操作者与 IP', async () => {
    const target = await t.makeUser({ email: 'victim@example.com' });

    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${target.id}`,
      headers: { ...t.auth(admin.token), 'x-forwarded-for': '203.0.113.9' },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);

    const [row] = t.repos.adminAuditRepo.rows;
    expect(row.actorUserId).toBe(admin.id);
    expect(row.actorEmail).toBe('root@example.com');
    expect(row.action).toBe('user.update');
    expect(row.targetId).toBe(String(target.id));
    expect(row.detail).toMatchObject({ role: { from: 'user', to: 'admin' } });
    // trustProxy: 1 → req.ip 取 X-Forwarded-For 的最后一跳
    expect(row.ip).toBe('203.0.113.9');
  });

  it('body 里塞 actorUserId 不被采信', async () => {
    const target = await t.makeUser();
    // schema 的 additionalProperties 会先挡下来；万一将来放开，
    // 也必须以认证身份为准而不是请求体
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${target.id}`,
      headers: t.auth(admin.token),
      payload: { planCode: 'pro', actorUserId: 999999 },
    });
    if (res.statusCode === 200) {
      expect(t.repos.adminAuditRepo.rows[0].actorUserId).toBe(admin.id);
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  it('手动续费留痕（免费发放付费套餐是最需要追溯的操作）', async () => {
    const target = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: `/admin/users/${target.id}/renew`,
      headers: t.auth(admin.token),
      payload: { planCode: 'pro', period: 'month' },
    });
    expect(res.statusCode).toBe(200);

    const row = t.repos.adminAuditRepo.rows.find((r) => r.action === 'user.renew');
    expect(row).toBeDefined();
    expect(row!.actorUserId).toBe(admin.id);
    expect(row!.detail).toMatchObject({ planCode: 'pro', period: 'month' });
  });

  it('改限流阈值留痕', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/auth-strict',
      headers: t.auth(admin.token),
      payload: { maxRequests: 3, windowSeconds: 60 },
    });
    expect(res.statusCode).toBe(200);
    const row = t.repos.adminAuditRepo.rows.find((r) => r.action === 'ratelimit.update');
    expect(row?.targetId).toBe('auth-strict');
    expect(row?.detail).toMatchObject({ maxRequests: 3 });
  });

  /**
   * 放行 IP 等于把限流这道防线对某个来源整体关掉，是安全边界的移动。
   */
  it('增删免限流 IP 都留痕', async () => {
    await t.app.inject({
      method: 'POST', url: '/admin/rate-limits/allowlist',
      headers: t.auth(admin.token), payload: { ip: '198.51.100.7', note: 'office' },
    });
    await t.app.inject({
      method: 'DELETE', url: '/admin/rate-limits/allowlist/198.51.100.7',
      headers: t.auth(admin.token),
    });

    const actions = t.repos.adminAuditRepo.rows.map((r) => r.action);
    expect(actions).toContain('ratelimit.allowlist.add');
    expect(actions).toContain('ratelimit.allowlist.remove');
  });

  it('吊销会话留痕', async () => {
    const target = await t.makeUser();
    const res = await t.app.inject({
      method: 'DELETE', url: `/admin/users/${target.id}/sessions/${target.sid}`,
      headers: t.auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(t.repos.adminAuditRepo.rows[0].action).toBe('session.revoke');
  });

  it('只读接口不留痕（否则审计表被列表请求灌满，真正的变更被埋掉）', async () => {
    await t.app.inject({ method: 'GET', url: '/admin/users?limit=10&offset=0', headers: t.auth(admin.token) });
    await t.app.inject({ method: 'GET', url: '/admin/plans', headers: t.auth(admin.token) });
    await t.app.inject({ method: 'GET', url: '/admin/subscriptions', headers: t.auth(admin.token) });
    expect(t.repos.adminAuditRepo.rows).toHaveLength(0);
  });
});

describe('自伤防护经 HTTP 生效', () => {
  it('admin 无法把自己降级（400，不是静默通过）', async () => {
    await t.makeUser({ role: 'admin', email: 'admin2@example.com' });

    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${admin.id}`,
      headers: t.auth(admin.token), payload: { role: 'user' },
    });
    expect(res.statusCode).toBe(400);
    expect((await t.repos.userRepo.findById(admin.id))!.role).toBe('admin');
    // 被拒绝的操作不留痕
    expect(t.repos.adminAuditRepo.rows).toHaveLength(0);
  });

  it('admin 无法禁用自己', async () => {
    await t.makeUser({ role: 'admin', email: 'admin2@example.com' });
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${admin.id}`,
      headers: t.auth(admin.token), payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * 唯一 admin 的场景在 HTTP 层必然与"自我降级"重合：能调这个接口的只有
   * active admin，而唯一的 active admin 就是请求者自己。跨账号的版本
   * （A 降 B，且 B 是最后一个）只能在 service 层构造，见
   * adminGuard.test.ts 的「最后一个 admin 保护」。
   */
  it('唯一的 admin 降级自己被拒', async () => {
    expect(await t.repos.userRepo.countAdmins()).toBe(1);
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${admin.id}`,
      headers: t.auth(admin.token), payload: { role: 'user' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /admin/audit', () => {
  it('倒序返回并带 total', async () => {
    const a = await t.makeUser({ email: 'a@example.com' });
    const b = await t.makeUser({ email: 'b@example.com' });
    for (const u of [a, b]) {
      await t.app.inject({
        method: 'PATCH', url: `/admin/users/${u.id}`,
        headers: t.auth(admin.token), payload: { planCode: 'pro' },
      });
    }

    const res = await t.app.inject({ method: 'GET', url: '/admin/audit?limit=10&offset=0', headers: t.auth(admin.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    // 最近的在前
    expect(body.entries[0].targetId).toBe(String(b.id));
  });

  it('普通用户读不到留痕', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({ method: 'GET', url: '/admin/audit', headers: t.auth(u.token) });
    expect(res.statusCode).toBe(403);
  });

  it('非法分页参数被 schema 挡成 400（不会拼出 LIMIT NaN）', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/audit?limit=abc', headers: t.auth(admin.token) });
    expect(res.statusCode).toBe(400);
  });
});
