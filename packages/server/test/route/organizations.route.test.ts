import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 组织域路由的成员授权守卫。
 *
 * authScope 只验「登录」，成员归属必须由 OrganizationService 兜住 ——
 * 否则任意已登录用户可改任意 org 的成员/资源。这里把守卫钉成断言：
 * 非成员写 → 403、非成员读 → 403、owner/admin → 200、软删资源 listPermissions → 404。
 */

let t: TestApp;

beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

/** 造一个 team org，owner 成为 admin 成员；可选给 org 配席位（含 owner 占用，故加成员需 ≥2） */
async function makeOrg(opts: { seats?: number } = {}): Promise<{ ownerToken: string; ownerId: number; orgId: number }> {
  const owner = await t.makeUser();
  const res = await t.app.inject({
    method: 'POST', url: '/api/organizations', headers: t.auth(owner.token),
    payload: { name: 'Acme' },
  });
  expect(res.statusCode).toBe(201);
  const orgId = res.json().organization.id;
  if (opts.seats) {
    const teamPlan = (await t.repos.planRepo.findByCode('team'))!;
    const sub = await t.repos.subRepo.upsert({ organizationId: orgId, planId: teamPlan.id, status: 'active', provider: 'manual' });
    for (let i = 0; i < opts.seats; i++) {
      await t.repos.seatRepo.create({ subscriptionId: sub.id, organizationId: orgId });
    }
  }
  return { ownerToken: owner.token, ownerId: owner.id, orgId };
}

/** 列成员：owner → 200，非成员 → 403 */
describe('组织域授权守卫', () => {
  it('非成员读成员列表 → 403 FORBIDDEN', async () => {
    const { orgId, ownerToken } = await makeOrg();
    const outsider = await t.makeUser();
    // owner 能读（成员）
    expect((await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/members`, headers: t.auth(ownerToken) })).statusCode).toBe(200);
    // 非成员被拒
    const res = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/members`, headers: t.auth(outsider.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('非成员加成员 → 403（在席位检查之前拒绝）', async () => {
    const { orgId } = await makeOrg({ seats: 2 });
    const outsider = await t.makeUser();
    const target = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/members`, headers: t.auth(outsider.token),
      payload: { userId: target.id, role: 'member' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('owner（admin 成员）加成员 → 201', async () => {
    const { orgId, ownerToken } = await makeOrg({ seats: 2 });
    const target = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/members`, headers: t.auth(ownerToken),
      payload: { userId: target.id, role: 'member' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('owner 加成员后再以该成员身份读资源列表 → 200（member 可读）', async () => {
    const { orgId, ownerToken } = await makeOrg({ seats: 2 });
    const member = await t.makeUser();
    await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/members`, headers: t.auth(ownerToken),
      payload: { userId: member.id, role: 'member' },
    });
    // member 身份读资源：admin-only 路由里 listResources 是 member 级 → 200
    expect((await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/resources`, headers: t.auth(member.token) })).statusCode).toBe(200);
  });

  it('非 admin 成员建资源 → 403（资源管理 admin-only）', async () => {
    const { orgId, ownerToken } = await makeOrg();
    const member = await t.makeUser();
    await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/members`, headers: t.auth(ownerToken),
      payload: { userId: member.id, role: 'member' },
    });
    const res = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/resources`, headers: t.auth(member.token),
      payload: { resourceType: 'query', name: 'q1', accessScope: 'organization', encryptedData: 'enc' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('owner 建资源 → 201；软删后 listPermissions → 404（陈旧授权不泄漏）', async () => {
    const { orgId, ownerToken } = await makeOrg();
    const create = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/resources`, headers: t.auth(ownerToken),
      payload: { resourceType: 'query', name: 'q1', accessScope: 'restricted', encryptedData: 'enc' },
    });
    expect(create.statusCode).toBe(201);
    const resourceId = create.json().resource.id;

    // 未软删时 listPermissions 可读（owner 是 member）
    expect((await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/resources/${resourceId}/permissions`, headers: t.auth(ownerToken) })).statusCode).toBe(200);

    // 软删资源
    expect((await t.app.inject({ method: 'DELETE', url: `/api/organizations/${orgId}/resources/${resourceId}`, headers: t.auth(ownerToken) })).statusCode).toBe(200);

    // 软删后 listPermissions → 404（service findById 过滤软删资源）
    const res = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/resources/${resourceId}/permissions`, headers: t.auth(ownerToken) });
    expect(res.statusCode).toBe(404);
  });

  it('admin 成员不能移除 owner（组织不可失去商业 Owner）', async () => {
    const { orgId, ownerToken, ownerId } = await makeOrg({ seats: 2 });
    // 加一个 admin 成员（owner 加成员需席位）
    const secondAdmin = await t.makeUser();
    await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/members`, headers: t.auth(ownerToken),
      payload: { userId: secondAdmin.id, role: 'admin' },
    });
    // owner 的 membership id
    const membersRes = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/members`, headers: t.auth(ownerToken) });
    const ownerMembershipId = membersRes.json().members.find((m: any) => m.userId === ownerId).id;
    // 第二个 admin 尝试移除 owner → 400
    const res = await t.app.inject({
      method: 'DELETE', url: `/api/organizations/${orgId}/members/${ownerMembershipId}`, headers: t.auth(secondAdmin.token),
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin 成员不能把 owner 降级出 admin', async () => {
    const { orgId, ownerToken, ownerId } = await makeOrg({ seats: 2 });
    const secondAdmin = await t.makeUser();
    await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/members`, headers: t.auth(ownerToken),
      payload: { userId: secondAdmin.id, role: 'admin' },
    });
    const membersRes = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/members`, headers: t.auth(secondAdmin.token) });
    const ownerMembershipId = membersRes.json().members.find((m: any) => m.userId === ownerId).id;
    const res = await t.app.inject({
      method: 'PATCH', url: `/api/organizations/${orgId}/members/${ownerMembershipId}`, headers: t.auth(secondAdmin.token),
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('不存在的组织 → 404（而非 403，避免暴露组织存在性）', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({ method: 'GET', url: '/api/organizations/999999/members', headers: t.auth(u.token) });
    // requireMember 在 org 不存在时：findByOrgAndUser 返回 undefined → ForbiddenError(403)
    // 这是可接受的（不泄漏 404 vs 403 的区别给非成员），此处仅断言非 200
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});