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
   * 回归：v2 无 users.plan_code。旧 admin-ui 仍发 planCode 时，Fastify 剔除
   * 未知字段（additionalProperties 不设 false），updateUser 空更新 → 200，
   * 不再产生孤儿套餐码（那在 v1 会让 /api/me 抛 plan not found → 500）。
   */
  it('未知字段 planCode 被剔除后空更新 → 200，不落库', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'PATCH', url: `/admin/users/${u.id}`, headers: t.auth(adminToken),
      payload: { planCode: 'bogus' },
    });
    expect(res.statusCode).toBe(200);
    expect((await t.repos.userRepo.findById(u.id))?.status).toBe('active');
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
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);
    expect((await t.repos.userRepo.findById(u.id))?.status).toBe('disabled');
  });

  it('非数字 :id → 400', async () => {
    const res = await t.app.inject({
      method: 'PATCH', url: '/admin/users/abc', headers: t.auth(adminToken),
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /admin/organizations/:id/renew', () => {
  async function personalOrgId(userId: number): Promise<number> {
    const memberships = await t.repos.membershipRepo.listByUser(userId);
    return memberships.find((m) => m.status === 'active')!.organizationId;
  }

  it('缺 body → 400 而非 500', async () => {
    const u = await t.makeUser();
    const orgId = await personalOrgId(u.id);
    const res = await t.app.inject({
      method: 'POST', url: `/admin/organizations/${orgId}/renew`, headers: t.auth(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).not.toContain('destructure');
  });

  it('非法 period → 400', async () => {
    const u = await t.makeUser();
    const orgId = await personalOrgId(u.id);
    const res = await t.app.inject({
      method: 'POST', url: `/admin/organizations/${orgId}/renew`, headers: t.auth(adminToken),
      payload: { planCode: 'pro', period: 'decade' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin-ui 实际载荷 {planCode, period} → 200', async () => {
    const u = await t.makeUser();
    const orgId = await personalOrgId(u.id);
    const res = await t.app.inject({
      method: 'POST', url: `/admin/organizations/${orgId}/renew`, headers: t.auth(adminToken),
      payload: { planCode: 'pro', period: 'month' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscription.organizationId).toBe(orgId);
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

  it('admin-ui 实际套餐字段载荷 → 200', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/admin/plans/pro', headers: t.auth(adminToken),
      payload: {
        name: 'Pro', priceMonth: 10, priceYear: 100,
        includedSeats: 1, perSeatMaxDevices: 5,
        perUserMaxPrivateConnections: 20, perUserMaxOpenConnections: 0,
        perUserPrivateSyncQuotaBytes: 10485760, perUserSyncVersionRetention: 10,
        perUserHistoryRetentionCount: 0, orgMaxSharedConnections: 0,
        orgSharedSyncQuotaBytes: 0, orgMaxMembers: 0, features: 7,
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
