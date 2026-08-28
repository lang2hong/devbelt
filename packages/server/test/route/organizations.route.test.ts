import { describe, it, expect } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import type { OrganizationRole } from '../../src/domain/enums.js';

async function makeUser(t: TestApp, email: string) {
  const user = await t.repos.userRepo.create(email, 'hash', undefined);
  const token = await t.tokenFor(user.id);
  return { id: user.id, token };
}

async function makeOrg(t: TestApp, name = 'Acme') {
  const org = await t.repos.organizationRepo.create({} as Queryable, { name });
  return org.id;
}

async function addMembership(t: TestApp, orgId: number, userId: number, role: OrganizationRole) {
  return t.repos.membershipRepo.create({} as Queryable, {
    organizationId: orgId,
    userId,
    role,
    status: 'active',
    invitedByUserId: null,
    joinedTime: new Date(),
    removedTime: null,
  });
}

describe('organization routes', () => {
  it('requires auth to list organizations', async () => {
    const t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/organizations' });
    expect(res.statusCode).toBe(401);
    await t.close();
  });

  it('creates an organization and lists it', async () => {
    const t = await buildTestApp();
    const { token } = await makeUser(t, 'a@b.com');
    const create = await t.app.inject({
      method: 'POST', url: '/api/organizations', headers: t.auth(token),
      payload: { name: 'Acme' },
    });
    expect(create.statusCode).toBe(201);
    const org = create.json().organization;
    expect(org.name).toBe('Acme');
    expect(org.role).toBe('admin');
    expect(typeof org.organizationId).toBe('string');

    const list = await t.app.inject({ method: 'GET', url: '/api/organizations', headers: t.auth(token) });
    expect(list.json().organizations).toHaveLength(1);
    await t.close();
  });

  it('a member can read but cannot update (forbidden)', async () => {
    const t = await buildTestApp();
    const owner = await makeUser(t, 'owner@b.com');
    const member = await makeUser(t, 'member@b.com');
    const orgId = await makeOrg(t);
    await addMembership(t, orgId, owner.id, 'admin');
    await addMembership(t, orgId, member.id, 'member');

    const read = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}`, headers: t.auth(member.token) });
    expect(read.statusCode).toBe(200);

    const update = await t.app.inject({
      method: 'PATCH', url: `/api/organizations/${orgId}`, headers: t.auth(member.token), payload: { name: 'x' },
    });
    expect(update.statusCode).toBe(403);
    expect(update.json().code).toBe('FORBIDDEN');
    await t.close();
  });

  it('non-member and closed org both return 404 (no enumeration)', async () => {
    const t = await buildTestApp();
    const outsider = await makeUser(t, 'out@b.com');
    const orgId = await makeOrg(t);
    const res = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}`, headers: t.auth(outsider.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ORGANIZATION_NOT_FOUND');

    await t.repos.organizationRepo.close({} as Queryable, orgId, new Date());
    const owner = await makeUser(t, 'ow2@b.com');
    await addMembership(t, orgId, owner.id, 'admin');
    const res2 = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}`, headers: t.auth(owner.token) });
    expect(res2.statusCode).toBe(404);
    await t.close();
  });

  it('member directory does not leak emails', async () => {
    const t = await buildTestApp();
    const owner = await makeUser(t, 'o@b.com');
    const orgId = await makeOrg(t);
    await addMembership(t, orgId, owner.id, 'admin');
    const res = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/members`, headers: t.auth(owner.token) });
    expect(res.statusCode).toBe(200);
    const members = res.json().members;
    expect(members).toHaveLength(1);
    expect(JSON.stringify(members)).not.toContain('o@b.com');
    expect(members[0].membershipId).toBeTruthy();
    await t.close();
  });

  it('admin can assign role by membership id', async () => {
    const t = await buildTestApp();
    const owner = await makeUser(t, 'o@c.com');
    const member = await makeUser(t, 'm@c.com');
    const orgId = await makeOrg(t);
    await addMembership(t, orgId, owner.id, 'admin');
    const memberM = await addMembership(t, orgId, member.id, 'member');

    const res = await t.app.inject({
      method: 'PATCH', url: `/api/organizations/${orgId}/members/${memberM.id}`, headers: t.auth(owner.token),
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);

    const memberList = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}/members`, headers: t.auth(owner.token) });
    const admins = memberList.json().members.filter((m: any) => m.role === 'admin');
    expect(admins).toHaveLength(2);
    await t.close();
  });

  it('a member gets 403 on role.assign, member.remove and organization.close', async () => {
    const t = await buildTestApp();
    const owner = await makeUser(t, 'o@d.com');
    const member = await makeUser(t, 'm@d.com');
    const target = await makeUser(t, 't@d.com');
    const orgId = await makeOrg(t);
    await addMembership(t, orgId, owner.id, 'admin');
    await addMembership(t, orgId, member.id, 'member');
    const targetM = await addMembership(t, orgId, target.id, 'member');

    const assign = await t.app.inject({
      method: 'PATCH', url: `/api/organizations/${orgId}/members/${targetM.id}`, headers: t.auth(member.token), payload: { role: 'admin' },
    });
    expect(assign.statusCode).toBe(403);

    const remove = await t.app.inject({
      method: 'DELETE', url: `/api/organizations/${orgId}/members/${targetM.id}`, headers: t.auth(member.token),
    });
    expect(remove.statusCode).toBe(403);

    const close = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/close`, headers: t.auth(member.token),
    });
    expect(close.statusCode).toBe(403);
    await t.close();
  });

  it('closing an organization via route makes it 404 afterwards', async () => {
    const t = await buildTestApp();
    const owner = await makeUser(t, 'o@e.com');
    const orgId = await makeOrg(t);
    await addMembership(t, orgId, owner.id, 'admin');

    const close = await t.app.inject({ method: 'POST', url: `/api/organizations/${orgId}/close`, headers: t.auth(owner.token) });
    expect(close.statusCode).toBe(200);

    const res = await t.app.inject({ method: 'GET', url: `/api/organizations/${orgId}`, headers: t.auth(owner.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ORGANIZATION_NOT_FOUND');
    await t.close();
  });

  it('cross-organization membership id via HTTP returns 404', async () => {
    const t = await buildTestApp();
    const owner = await makeUser(t, 'o@f.com');
    const member = await makeUser(t, 'm@f.com');
    const orgA = await makeOrg(t, 'A');
    const orgB = await makeOrg(t, 'B');
    await addMembership(t, orgA, owner.id, 'admin');
    await addMembership(t, orgB, owner.id, 'admin');
    const memberInA = await addMembership(t, orgA, member.id, 'member');

    const res = await t.app.inject({
      method: 'PATCH', url: `/api/organizations/${orgB}/members/${memberInA.id}`, headers: t.auth(owner.token),
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    await t.close();
  });
});