import { describe, it, expect } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import type { OrganizationRole } from '../../src/domain/enums.js';

async function makeUser(t: TestApp, email: string) {
  const user = await t.repos.userRepo.create(email, 'hash', undefined);
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

async function createOrg(t: TestApp, email: string, name = 'Acme') {
  const owner = await makeUser(t, email);
  const res = await t.app.inject({ method: 'POST', url: '/api/organizations', headers: t.auth(owner.token), payload: { name } });
  return { orgId: res.json().organization.organizationId as string, owner };
}

describe('organization resource routes', () => {
  it('member cannot create/update/delete folders or resources', async () => {
    const t = await buildTestApp();
    const { orgId, owner } = await createOrg(t, 'owner@x.com');
    const member = await makeUser(t, 'member@x.com');
    await addMembership(t, Number(orgId), member.id, 'member');

    const postFolder = await t.app.inject({ method: 'POST', url: `/api/organizations/${orgId}/folders`, headers: t.auth(member.token), payload: { name: 'F' } });
    expect(postFolder.statusCode).toBe(403);

    const postResource = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/resources`, headers: t.auth(member.token),
      payload: { resourceType: 'query', name: 'q', content: { sql: 'select 1' } },
    });
    expect(postResource.statusCode).toBe(403);
    await t.close();
    void owner;
  });

  it('cross-organization folderId returns 404', async () => {
    const t = await buildTestApp();
    const { orgId: orgA, owner: a } = await createOrg(t, 'a@x.com', 'A');
    const { orgId: orgB, owner: b } = await createOrg(t, 'b@x.com', 'B');

    const folder = await t.app.inject({ method: 'POST', url: `/api/organizations/${orgA}/folders`, headers: t.auth(a.token), payload: { name: 'F' } });
    const folderId = folder.json().folder.folderId;

    const res = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgB}/resources`, headers: t.auth(b.token),
      payload: { resourceType: 'query', name: 'q', folderId, content: { sql: 'select 1' } },
    });
    expect(res.statusCode).toBe(404);
    await t.close();
  });

  it('folder move into own descendant returns 409 FOLDER_MOVE_CYCLE', async () => {
    const t = await buildTestApp();
    const { orgId, owner } = await createOrg(t, 'o@x.com');
    const a = await t.app.inject({ method: 'POST', url: `/api/organizations/${orgId}/folders`, headers: t.auth(owner.token), payload: { name: 'A' } });
    const aId = a.json().folder.folderId;
    await t.app.inject({ method: 'POST', url: `/api/organizations/${orgId}/folders`, headers: t.auth(owner.token), payload: { name: 'B', parentId: aId } });

    const res = await t.app.inject({ method: 'PATCH', url: `/api/organizations/${orgId}/folders/${aId}`, headers: t.auth(owner.token), payload: { parentId: aId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('FOLDER_MOVE_CYCLE');
    await t.close();
  });

  it('delete non-empty folder returns 409 FOLDER_NOT_EMPTY', async () => {
    const t = await buildTestApp();
    const { orgId, owner } = await createOrg(t, 'o@x.com');
    const f = await t.app.inject({ method: 'POST', url: `/api/organizations/${orgId}/folders`, headers: t.auth(owner.token), payload: { name: 'F' } });
    const folderId = f.json().folder.folderId;
    await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/resources`, headers: t.auth(owner.token),
      payload: { resourceType: 'query', name: 'q', folderId, content: { sql: 'select 1' } },
    });
    const res = await t.app.inject({ method: 'DELETE', url: `/api/organizations/${orgId}/folders/${folderId}`, headers: t.auth(owner.token) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('FOLDER_NOT_EMPTY');
    await t.close();
  });

  it('disallowed engine returns 403 ORGANIZATION_FEATURE_REQUIRED', async () => {
    const t = await buildTestApp();
    const { orgId, owner } = await createOrg(t, 'o@x.com');
    const res = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/resources`, headers: t.auth(owner.token),
      payload: { resourceType: 'connection_template', name: 'c', content: { databaseType: 'postgresql', host: 'h', port: 5432, database: 'db' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ORGANIZATION_FEATURE_REQUIRED');
    await t.close();
  });

  it('secret field in content returns 400 RESOURCE_CONTENT_INVALID', async () => {
    const t = await buildTestApp();
    const { orgId, owner } = await createOrg(t, 'o@x.com');
    const res = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/resources`, headers: t.auth(owner.token),
      payload: { resourceType: 'query', name: 'q', content: { sql: 'select 1', password: 'p' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('RESOURCE_CONTENT_INVALID');
    await t.close();
  });

  it('optimistic-lock conflict returns currentVersion in the 409 body', async () => {
    const t = await buildTestApp();
    const { orgId, owner } = await createOrg(t, 'o@x.com');
    const created = await t.app.inject({
      method: 'POST', url: `/api/organizations/${orgId}/resources`, headers: t.auth(owner.token),
      payload: { resourceType: 'query', name: 'q', content: { sql: 'select 1' } },
    });
    const resourceId = created.json().resource.resourceId;

    await t.app.inject({ method: 'PATCH', url: `/api/organizations/${orgId}/resources/${resourceId}`, headers: t.auth(owner.token), payload: { baseVersion: 1, name: 'q2' } });

    const res = await t.app.inject({ method: 'PATCH', url: `/api/organizations/${orgId}/resources/${resourceId}`, headers: t.auth(owner.token), payload: { baseVersion: 1, name: 'q3' } });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('RESOURCE_VERSION_CONFLICT');
    expect(body.currentVersion).toBe(2);
    await t.close();
  });
});