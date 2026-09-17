import { describe, it, expect } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import type { OrganizationRole } from '../../src/domain/enums.js';

async function makeUser(t: TestApp, email: string) {
  const user = await t.repos.userRepo.create(email, 'hash', undefined);
  const token = await t.tokenFor(user.id);
  return { id: user.id, token };
}

async function makeVerifiedUser(t: TestApp, email: string) {
  const user = await t.repos.userRepo.create(email, 'hash', undefined);
  await t.repos.userRepo.markEmailVerified({} as Queryable, user.id, new Date());
  const token = await t.tokenFor(user.id);
  return { id: user.id, token };
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

describe('invitation routes', () => {
  it('admin can invite, list and revoke; member cannot invite', async () => {
    const t = await buildTestApp();
    const admin = await makeUser(t, 'admin@x.com');
    await makeVerifiedUser(t, 'target@x.com');

    const create = await t.app.inject({
      method: 'POST', url: '/api/db/organizations', headers: t.auth(admin.token), payload: { name: 'Acme' },
    });
    const orgId = create.json().organization.organizationId;

    const invite = await t.app.inject({
      method: 'POST', url: `/api/db/organizations/${orgId}/invitations`, headers: t.auth(admin.token), payload: { email: 'target@x.com' },
    });
    expect(invite.statusCode).toBe(201);
    const invitationId = invite.json().invitation.invitationId;

    const list = await t.app.inject({ method: 'GET', url: `/api/db/organizations/${orgId}/invitations`, headers: t.auth(admin.token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().invitations).toHaveLength(1);
    expect(list.json().invitations[0].email).toBe('target@x.com');
    expect(list.json().invitations[0].invitationId).toBe(invitationId);

    const member = await makeUser(t, 'member@x.com');
    await addMembership(t, Number(orgId), member.id, 'member');
    const memberInvite = await t.app.inject({
      method: 'POST', url: `/api/db/organizations/${orgId}/invitations`, headers: t.auth(member.token), payload: { email: 'other@x.com' },
    });
    expect(memberInvite.statusCode).toBe(403);

    const revoke = await t.app.inject({
      method: 'DELETE', url: `/api/db/organizations/${orgId}/invitations/${invitationId}`, headers: t.auth(admin.token),
    });
    expect(revoke.statusCode).toBe(200);

    const listAfter = await t.app.inject({ method: 'GET', url: `/api/db/organizations/${orgId}/invitations`, headers: t.auth(admin.token) });
    expect(listAfter.json().invitations).toHaveLength(0);
    await t.close();
  });

  it('accept requires auth and activates membership via emailed token', async () => {
    const t = await buildTestApp();
    const admin = await makeUser(t, 'admin@x.com');
    const target = await makeVerifiedUser(t, 'target@x.com');

    const create = await t.app.inject({
      method: 'POST', url: '/api/db/organizations', headers: t.auth(admin.token), payload: { name: 'Acme' },
    });
    const orgId = create.json().organization.organizationId;

    await t.app.inject({
      method: 'POST', url: `/api/db/organizations/${orgId}/invitations`, headers: t.auth(admin.token), payload: { email: 'target@x.com' },
    });
    const token = t.services.emailSender.sent.find((m) => m.kind === 'invitation')!.token!;

    const accept = await t.app.inject({
      method: 'POST', url: `/api/db/organization-invitations/${token}/accept`, headers: t.auth(target.token),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().organization.organizationId).toBe(orgId);
    expect(accept.json().organization.role).toBe('member');

    const members = await t.app.inject({ method: 'GET', url: `/api/db/organizations/${orgId}/members`, headers: t.auth(admin.token) });
    const invitedOrJoined = members.json().members.find((m: any) => m.status === 'active');
    expect(invitedOrJoined).toBeTruthy();
    await t.close();
  });

  it('accept without auth returns 401', async () => {
    const t = await buildTestApp();
    const res = await t.app.inject({ method: 'POST', url: '/api/db/organization-invitations/whatever/accept' });
    expect(res.statusCode).toBe(401);
    await t.close();
  });
});