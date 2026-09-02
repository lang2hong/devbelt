import { describe, it, expect } from 'vitest';
import {
  FakeOrganizationRepo,
  FakeOrganizationSubscriptionRepo,
  FakeMembershipRepo,
  FakeFolderRepo,
  FakeResourceRepo,
} from '../helpers/fakeRepos.js';
import { OrganizationResourceService } from '../../src/service/organizationResourceService.js';
import {
  EntityNotFoundError,
  ForbiddenError,
  OrganizationNotFoundError,
  ResourceNotFoundError,
  OrganizationQuotaExceededError,
  OrganizationFeatureRequiredError,
  ResourceVersionConflictError,
  FolderNotEmptyError,
  FolderMoveCycleError,
} from '../../src/domain/errors.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

interface Snapshot {
  maxSharedResources: number;
  sharedStorageQuotaBytes: number;
  allowedTemplateDatabaseTypes: string[];
  [key: string]: unknown;
}

function makeStack(snapshot: Snapshot = { maxSharedResources: 50, sharedStorageQuotaBytes: 10485760, allowedTemplateDatabaseTypes: ['mysql'] }) {
  const organizationRepo = new FakeOrganizationRepo();
  const organizationSubscriptionRepo = new FakeOrganizationSubscriptionRepo();
  const membershipRepo = new FakeMembershipRepo();
  const resourceRepo = new FakeResourceRepo();
  const folderRepo = new FakeFolderRepo(resourceRepo);
  const svc = new OrganizationResourceService(
    organizationRepo,
    organizationSubscriptionRepo,
    membershipRepo,
    folderRepo,
    resourceRepo,
    async (fn) => fn({} as Queryable),
  );
  return { svc, organizationRepo, organizationSubscriptionRepo, membershipRepo, folderRepo, resourceRepo, snapshot };
}

/** 组织内的 active admin 操作者（写操作在事务内复核其权限）。 */
const ADMIN = 1;

async function makeOrg(stack: ReturnType<typeof makeStack>) {
  const org = await stack.organizationRepo.create({} as Queryable, { name: 'Acme' });
  await stack.organizationSubscriptionRepo.create({} as Queryable, {
    organizationId: org.id,
    planId: 1,
    seatLimit: 3,
    status: 'active',
    entitlementSnapshot: stack.snapshot,
    periodStartTime: new Date(),
    periodEndTime: null,
  });
  await stack.membershipRepo.create({} as Queryable, {
    organizationId: org.id,
    userId: ADMIN,
    role: 'admin',
    status: 'active',
    invitedByUserId: null,
    joinedTime: new Date(),
    removedTime: null,
  });
  return org;
}

const QUERY = { sql: 'select 1' };
const CT = (db: string) => ({ databaseType: db, host: 'localhost', port: 3306, database: 'db' });

describe('OrganizationResourceService folders', () => {
  it('creates and lists folders', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const root = await stack.svc.createFolder(org.id, ADMIN, 'Root');
    const child = await stack.svc.createFolder(org.id, ADMIN, 'Child', root.folderId);
    const list = await stack.svc.listFolders(org.id);
    expect(list).toHaveLength(2);
    expect(child.parentId).toBe(root.folderId);
  });

  it('rejects parent in another org / missing / soft-deleted', async () => {
    const stack = makeStack();
    const orgA = await makeOrg(stack);
    const orgB = await stack.organizationRepo.create({} as Queryable, { name: 'B' });
    await stack.organizationSubscriptionRepo.create({} as Queryable, {
      organizationId: orgB.id, planId: 1, seatLimit: 3, status: 'active',
      entitlementSnapshot: stack.snapshot, periodStartTime: new Date(), periodEndTime: null,
    });
    await stack.membershipRepo.create({} as Queryable, {
      organizationId: orgB.id, userId: ADMIN, role: 'admin', status: 'active',
      invitedByUserId: null, joinedTime: new Date(), removedTime: null,
    });

    const folderInA = await stack.svc.createFolder(orgA.id, ADMIN, 'A');
    await expect(stack.svc.createFolder(orgB.id, ADMIN, 'X', folderInA.folderId)).rejects.toBeInstanceOf(EntityNotFoundError);

    const del = await stack.svc.createFolder(orgA.id, ADMIN, 'ToDelete');
    await stack.svc.deleteFolder(orgA.id, ADMIN, del.folderId);
    await expect(stack.svc.createFolder(orgA.id, ADMIN, 'X', del.folderId)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('rejects moving a folder into itself or its own descendant (cycle)', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const a = await stack.svc.createFolder(org.id, ADMIN, 'A');
    const b = await stack.svc.createFolder(org.id, ADMIN, 'B', a.folderId);
    await expect(stack.svc.updateFolder(org.id, ADMIN, a.folderId, { parentId: a.folderId })).rejects.toBeInstanceOf(FolderMoveCycleError);
    await expect(stack.svc.updateFolder(org.id, ADMIN, a.folderId, { parentId: b.folderId })).rejects.toBeInstanceOf(FolderMoveCycleError);
  });

  it('rejects deleting a non-empty folder', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const folder = await stack.svc.createFolder(org.id, ADMIN, 'F');
    await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q', folderId: folder.folderId, content: QUERY });
    await expect(stack.svc.deleteFolder(org.id, ADMIN, folder.folderId)).rejects.toBeInstanceOf(FolderNotEmptyError);
    await stack.svc.createFolder(org.id, ADMIN, 'child', folder.folderId);
    await expect(stack.svc.deleteFolder(org.id, ADMIN, folder.folderId)).rejects.toBeInstanceOf(FolderNotEmptyError);
  });
});

describe('OrganizationResourceService resources', () => {
  it('creates resource at version 1 and lists summaries without content', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const created = await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q', content: QUERY });
    expect(created.version).toBe(1);
    const list = await stack.svc.listResources(org.id);
    expect(list).toHaveLength(1);
    expect((list[0] as any).content).toBeUndefined();
  });

  it('rejects disallowed engine with ORGANIZATION_FEATURE_REQUIRED', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    await expect(stack.svc.createResource(org.id, ADMIN, { resourceType: 'connection_template', name: 'c', content: CT('postgresql') }))
      .rejects.toBeInstanceOf(OrganizationFeatureRequiredError);
  });

  it('enforces resource count quota', async () => {
    const stack = makeStack({ maxSharedResources: 2, sharedStorageQuotaBytes: 0, allowedTemplateDatabaseTypes: ['mysql'] });
    const org = await makeOrg(stack);
    await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q1', content: QUERY });
    await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q2', content: QUERY });
    await expect(stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q3', content: QUERY })).rejects.toBeInstanceOf(OrganizationQuotaExceededError);
  });

  it('0 = infinite skips quota dimension', async () => {
    const stack = makeStack({ maxSharedResources: 0, sharedStorageQuotaBytes: 0, allowedTemplateDatabaseTypes: ['mysql'] });
    const org = await makeOrg(stack);
    for (let i = 0; i < 10; i++) {
      await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: `q${i}`, content: QUERY });
    }
    expect(await stack.svc.listResources(org.id)).toHaveLength(10);
  });

  it('optimistic lock: update conflicts on stale baseVersion and bumps version', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const created = await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q', content: QUERY });
    await stack.svc.updateResource(org.id, ADMIN, created.resourceId, { baseVersion: 1, name: 'q2' });
    let conflict: unknown;
    try {
      await stack.svc.updateResource(org.id, ADMIN, created.resourceId, { baseVersion: 1, name: 'q3' });
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeInstanceOf(ResourceVersionConflictError);
    expect((conflict as ResourceVersionConflictError).currentVersion).toBe(2);
  });

  it('cross-org resource id returns RESOURCE_NOT_FOUND', async () => {
    const stack = makeStack();
    const orgA = await makeOrg(stack);
    const orgB = await stack.organizationRepo.create({} as Queryable, { name: 'B' });
    await stack.organizationSubscriptionRepo.create({} as Queryable, {
      organizationId: orgB.id, planId: 1, seatLimit: 3, status: 'active',
      entitlementSnapshot: stack.snapshot, periodStartTime: new Date(), periodEndTime: null,
    });
    await stack.membershipRepo.create({} as Queryable, {
      organizationId: orgB.id, userId: ADMIN, role: 'admin', status: 'active',
      invitedByUserId: null, joinedTime: new Date(), removedTime: null,
    });
    const created = await stack.svc.createResource(orgA.id, ADMIN, { resourceType: 'query', name: 'q', content: QUERY });
    await expect(stack.svc.getResource(orgB.id, created.resourceId)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('soft delete releases count quota immediately', async () => {
    const stack = makeStack({ maxSharedResources: 1, sharedStorageQuotaBytes: 0, allowedTemplateDatabaseTypes: ['mysql'] });
    const org = await makeOrg(stack);
    const created = await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q1', content: QUERY });
    await stack.svc.deleteResource(org.id, ADMIN, created.resourceId);
    await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q2', content: QUERY });
  });

  it('moving a resource locks the target folder before the resource', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const f1 = await stack.svc.createFolder(org.id, ADMIN, 'F1');
    const f2 = await stack.svc.createFolder(org.id, ADMIN, 'F2');
    const res = await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q', folderId: f1.folderId, content: QUERY });

    const order: string[] = [];
    const folderRepo = stack.folderRepo as any;
    const resourceRepo = stack.resourceRepo as any;
    const origFolderLock = folderRepo.findByIdForUpdate.bind(folderRepo);
    const origResourceLock = resourceRepo.findByIdForUpdate.bind(resourceRepo);
    folderRepo.findByIdForUpdate = async (exec: unknown, orgId: number, id: number) => { order.push('folder'); return origFolderLock(exec, orgId, id); };
    resourceRepo.findByIdForUpdate = async (exec: unknown, orgId: number, id: number) => { order.push('resource'); return origResourceLock(exec, orgId, id); };

    await stack.svc.updateResource(org.id, ADMIN, res.resourceId, { baseVersion: 1, folderId: f2.folderId });

    expect(order.indexOf('folder')).toBeLessThan(order.indexOf('resource'));
    expect(order).toEqual(['folder', 'resource']);
  });
});

describe('OrganizationResourceService actor authorization (re-checked in tx)', () => {
  it('rejects a non-member actor on folder and resource writes', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    await expect(stack.svc.createFolder(org.id, 999, 'F')).rejects.toBeInstanceOf(OrganizationNotFoundError);
    await expect(stack.svc.createResource(org.id, 999, { resourceType: 'query', name: 'q', content: QUERY }))
      .rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('rejects an actor demoted to member after middleware authorization', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const created = await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q', content: QUERY });
    const membership = await stack.membershipRepo.findByOrgAndUser(org.id, ADMIN);
    await stack.membershipRepo.updateRole({} as Queryable, membership!.id, 'member');

    await expect(stack.svc.createFolder(org.id, ADMIN, 'F')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(stack.svc.updateResource(org.id, ADMIN, created.resourceId, { baseVersion: 1, name: 'x' }))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(stack.svc.deleteResource(org.id, ADMIN, created.resourceId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('attributes the author to the membership resolved inside the transaction', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const membership = await stack.membershipRepo.findByOrgAndUser(org.id, ADMIN);
    const created = await stack.svc.createResource(org.id, ADMIN, { resourceType: 'query', name: 'q', content: QUERY });
    expect(created.createdByMembershipId).toBe(membership!.id);
  });
});
