import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 管理端路由的 HTTP 层。
 *
 * 最重要的一条回归：`GET /admin/users?limit=abc` —— `Number('abc')` 得到 NaN，
 * 拼进 `LIMIT NaN` 让 mysql2 报语法错，而这个 handler 此前没有 try/catch，
 * 于是 MySQL 原始报错（含插值后的 SQL）会经 Fastify 默认处理器回显给客户端。
 * 现在 schema 在入口就把它挡成 400。
 *
 * 另一条：RBAC 此前从 token 声明读 role，admin 被降级后 15 分钟内仍是 admin。
 */

let t: TestApp;
let adminToken: string;

beforeEach(async () => {
  t = await buildTestApp();
  adminToken = (await t.makeUser({ role: 'admin' })).token;
});
afterEach(async () => { await t.close(); });

describe('RBAC', () => {
  it('无 token → 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/plans' });
    expect(res.statusCode).toBe(401);
  });

  it('普通用户 → 403', async () => {
    const { token } = await t.makeUser({ role: 'user' });
    const res = await t.app.inject({ method: 'GET', url: '/admin/plans', headers: t.auth(token) });
    expect(res.statusCode).toBe(403);
  });

  it('admin → 200', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/plans', headers: t.auth(adminToken) });
    expect(res.statusCode).toBe(200);
  });

  /**
   * 回归：role 以 DB 为准而非 token 声明。
   * 只读 token 的话，降级后旧 access token 在有效期内仍具 admin 权限。
   */
  it('降级后旧 token 立即失效（role 取自 DB）', async () => {
    const admin = await t.makeUser({ role: 'admin' });
    expect((await t.app.inject({
      method: 'GET', url: '/admin/plans', headers: t.auth(admin.token),
    })).statusCode).toBe(200);

    await t.repos.userRepo.updateRole(admin.id, 'user');

    const res = await t.app.inject({
      method: 'GET', url: '/admin/plans', headers: t.auth(admin.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('提权后的 token 声明不被采信（token 说 admin，DB 说 user）', async () => {
    const u = await t.makeUser({ role: 'user' });
    // 用本人的真实会话 sid，把变量隔离成只有 role 一项 —— 否则会被会话校验
    // 提前拦成 401，测不到 role 分支
    const forged = t.tokenFor(u.id, { role: 'admin', sid: u.sid });
    const res = await t.app.inject({ method: 'GET', url: '/admin/plans', headers: t.auth(forged) });
    expect(res.statusCode).toBe(403);
  });

  it('禁用的 admin → 403 USER_DISABLED', async () => {
    const admin = await t.makeUser({ role: 'admin' });
    await t.repos.userRepo.updateStatus(admin.id, 'disabled');
    const res = await t.app.inject({
      method: 'GET', url: '/admin/plans', headers: t.auth(admin.token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('USER_DISABLED');
  });
});

describe('GET /admin/users 分页参数', () => {
  it('limit=abc → 400，不回显 SQL 错误', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/users?limit=abc', headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
    // 校验报错里出现字段名 limit 是正常的；要挡住的是 SQL/驱动细节
    const body = JSON.stringify(res.json());
    expect(body).not.toMatch(/sqlMessage|sqlState|ER_[A-Z_]+|SELECT |LIMIT NaN/);
  });

  it('limit 超上界 → 400（避免整表进内存）', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/users?limit=999999', headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
  });

  it('offset 负数 → 400', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/users?offset=-5', headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
  });

  it('不带参数 → 200（用默认值）', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/users', headers: t.auth(adminToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('total');
  });

  it('admin-ui 实际用的 limit=500&offset=0 → 200', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/users?limit=500&offset=0', headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('PATCH /admin/users/:id', () => {
  it('非法 role → 400（此前可写入任意字符串）', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${u.id}`, headers: t.auth(adminToken),
      payload: { role: 'superadmin' },
    });
    expect(res.statusCode).toBe(400);
    expect((await t.repos.userRepo.findById(u.id))?.role).toBe('user');
  });

  /**
   * 回归：`users.plan_code` 没有 FK 指向 `plans.code`，写入孤儿套餐码后
   * 后续 `/api/me` 会因 `plan not found` 抛裸 Error → 500。
   */
  it('非法 planCode → 400，不产生孤儿套餐码', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${u.id}`, headers: t.auth(adminToken),
      payload: { planCode: 'bogus' },
    });
    expect(res.statusCode).toBe(400);
    expect((await t.repos.userRepo.findById(u.id))?.planCode).toBe('free');
  });

  it('非法 status → 400', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${u.id}`, headers: t.auth(adminToken),
      payload: { status: 'zombie' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('单字段更新 → 200（admin-ui 一次只发一个键）', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${u.id}`, headers: t.auth(adminToken),
      payload: { planCode: 'pro' },
    });
    expect(res.statusCode).toBe(200);
    expect((await t.repos.userRepo.findById(u.id))?.planCode).toBe('pro');
  });

  it('非数字 :id → 400', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/users/abc', headers: t.auth(adminToken),
      payload: { planCode: 'pro' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /admin/users/:id/renew', () => {
  it('缺 body → 400 而非 500', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: `/admin/users/${u.id}/renew`, headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).not.toContain('destructure');
  });

  it('非法 period → 400', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: `/admin/users/${u.id}/renew`, headers: t.auth(adminToken),
      payload: { planCode: 'pro', period: 'decade' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin-ui 实际载荷 {planCode, period} → 200', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: `/admin/users/${u.id}/renew`, headers: t.auth(adminToken),
      payload: { planCode: 'pro', period: 'month' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscription.planCode).toBe('pro');
  });
});

describe('POST /admin/plans/:code', () => {
  it('非法 code → 400', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/plans/enterprise', headers: t.auth(adminToken),
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('负价格 → 400', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/plans/pro', headers: t.auth(adminToken),
      payload: { name: 'Pro', priceMonth: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin-ui 实际的 7 字段载荷 → 200', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/plans/pro', headers: t.auth(adminToken),
      payload: {
        name: 'Pro', priceMonth: 10, priceYear: 100,
        maxConnections: 20, syncQuotaBytes: 10485760,
        syncVersionRetention: 10, features: 7,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('列表端点的错误不再回显内部信息', () => {
  /**
   * 这 9 个端点此前没有 try/catch，仓储抛错会经默认处理器把 err.message
   * 回显出去。现在有全局 setErrorHandler + 各自的 try/catch 双层兜底。
   */
  it('仓储抛错 → 500 固定文案', async () => {
    const u = await t.makeUser();
    t.repos.deviceRepo.listByUser = async () => {
      throw new Error('ER_BAD_FIELD_ERROR: Unknown column secret_col in field list');
    };
    const res = await t.app.inject({
      method: 'GET', url: `/admin/users/${u.id}/devices`, headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ message: 'Internal server error' });
    expect(JSON.stringify(res.json())).not.toContain('secret_col');
  });
});

describe('不存在的用户', () => {
  it('GET /admin/users/:id → 404', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/users/99999', headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /admin/traffic', () => {
  it('非 admin → 403', async () => {
    const { token } = await t.makeUser({ role: 'user' });
    const res = await t.app.inject({
      method: 'GET', url: '/admin/traffic', headers: t.auth(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('无 token → 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/admin/traffic' })).statusCode).toBe(401);
  });

  it('默认 24 小时窗口', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/traffic', headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hours).toBe(24);
  });

  it('hours 可指定', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/traffic?hours=72', headers: t.auth(adminToken),
    });
    expect(res.json().hours).toBe(72);
  });

  it.each([['0', 400], ['721', 400], ['abc', 400], ['-1', 400], ['1', 200], ['720', 200]])(
    'hours=%s → %i',
    async (hours, expected) => {
      const res = await t.app.inject({
        method: 'GET', url: `/admin/traffic?hours=${hours}`, headers: t.auth(adminToken),
      });
      expect(res.statusCode).toBe(expected);
    },
  );

  it('返回聚合好的结构（前端不做计算）', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/traffic', headers: t.auth(adminToken),
    });
    const body = res.json();
    expect(Array.isArray(body.routes)).toBe(true);
    expect(Array.isArray(body.hourly)).toBe(true);
    expect(body.minutes).toHaveLength(60);
    expect(Array.isArray(body.blocked)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  /**
   * 端点内部会先 flush 一次，否则刚发生的请求要等下一个定时周期才可见 ——
   * 管理员刷新页面看不到自己刚才那次访问会很困惑。
   */
  it('先 flush 再查，能看到刚发生的请求', async () => {
    await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(adminToken) });
    const res = await t.app.inject({
      method: 'GET', url: '/admin/traffic', headers: t.auth(adminToken),
    });
    const routes = res.json().routes.map((r: any) => r.route);
    expect(routes).toContain('/api/me');
  });
});

describe('GET /admin/rate-limits', () => {
  it('非 admin → 403', async () => {
    const { token } = await t.makeUser({ role: 'user' });
    expect(
      (await t.app.inject({ method: 'GET', url: '/admin/rate-limits', headers: t.auth(token) }))
        .statusCode,
    ).toBe(403);
  });

  it('列出全部桶，带说明与 isDefault 标记', async () => {
    const res = await t.app.inject({
      method: 'GET', url: '/admin/rate-limits', headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const { rules, allowlist } = res.json();
    expect(rules).toHaveLength(5);
    expect(rules.every((r: any) => r.isDefault)).toBe(true);
    expect(rules.every((r: any) => typeof r.description === 'string' && r.description.length > 0)).toBe(true);
    expect(allowlist).toEqual([]);
  });
});

describe('PATCH /admin/rate-limits/:bucket', () => {
  it('非 admin → 403', async () => {
    const { token } = await t.makeUser({ role: 'user' });
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/default',
      headers: t.auth(token), payload: { maxRequests: 10 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('改阈值 → 立即生效并回显全部规则', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/auth-strict',
      headers: t.auth(adminToken), payload: { maxRequests: 42 },
    });
    expect(res.statusCode).toBe(200);
    expect(t.rateLimitConfig.get('auth-strict').maxRequests).toBe(42);
    const row = res.json().rules.find((r: any) => r.bucket === 'auth-strict');
    expect(row.maxRequests).toBe(42);
    expect(row.isDefault).toBe(false);
  });

  it('写进了 DB（重启后仍生效）', async () => {
    await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/admin',
      headers: t.auth(adminToken), payload: { windowSeconds: 120 },
    });
    expect(t.repos.rateLimitRepo.rules.get('admin')?.windowSeconds).toBe(120);
  });

  it('未知桶名 → 400（enum 白名单）', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/nonexistent',
      headers: t.auth(adminToken), payload: { maxRequests: 10 },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * maxRequests 下限是 1 而不是 0：0 等于全部拒绝，那是把自己锁死。
   * 要停用某个桶应该用 enabled:false，语义清楚且可逆。
   */
  it('maxRequests=0 → 400（停用请用 enabled:false）', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/default',
      headers: t.auth(adminToken), payload: { maxRequests: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('windowSeconds 超过 1 天 → 400', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/default',
      headers: t.auth(adminToken), payload: { windowSeconds: 86_401 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enabled:false 可停用', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/sync-write',
      headers: t.auth(adminToken), payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(t.rateLimitConfig.get('sync-write').enabled).toBe(false);
  });

  it('空 body 是合法 no-op', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/rate-limits/default',
      headers: t.auth(adminToken), payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('/admin/rate-limits/allowlist', () => {
  it('非 admin → 403', async () => {
    const { token } = await t.makeUser({ role: 'user' });
    const res = await t.app.inject({
      method: 'POST', url: '/admin/rate-limits/allowlist',
      headers: t.auth(token), payload: { ip: '1.1.1.1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('加入 → 回显列表且内存立即生效', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/rate-limits/allowlist',
      headers: t.auth(adminToken), payload: { ip: '203.0.113.9', note: 'HQ office' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowlist).toContain('203.0.113.9');
    expect(t.rateLimitConfig.isAllowed('203.0.113.9')).toBe(true);
    expect(t.repos.rateLimitRepo.allowlist.get('203.0.113.9')?.note).toBe('HQ office');
  });

  it('删除 → 立即失效', async () => {
    await t.app.inject({
      method: 'POST', url: '/admin/rate-limits/allowlist',
      headers: t.auth(adminToken), payload: { ip: '10.0.0.1' },
    });
    const res = await t.app.inject({
      method: 'DELETE', url: '/admin/rate-limits/allowlist/10.0.0.1',
      headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().allowlist).not.toContain('10.0.0.1');
    expect(t.rateLimitConfig.isAllowed('10.0.0.1')).toBe(false);
  });

  it('缺 ip → 400', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/rate-limits/allowlist',
      headers: t.auth(adminToken), payload: { note: 'no ip' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ip 超长 → 400（与 DB 列宽 45 对齐）', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/rate-limits/allowlist',
      headers: t.auth(adminToken), payload: { ip: 'x'.repeat(46) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('IPv6 地址可加入', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/rate-limits/allowlist',
      headers: t.auth(adminToken), payload: { ip: '2001:db8::1' },
    });
    expect(res.statusCode).toBe(200);
    expect(t.rateLimitConfig.isAllowed('2001:db8::1')).toBe(true);
  });

  it('删除不存在的 IP 不报错（幂等）', async () => {
    const res = await t.app.inject({
      method: 'DELETE', url: '/admin/rate-limits/allowlist/9.9.9.9',
      headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
  });
});
