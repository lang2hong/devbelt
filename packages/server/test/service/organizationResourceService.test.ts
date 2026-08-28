import { describe, it, expect } from 'vitest';
import {
  FakeOrganizationRepo,
  FakeOrganizationSubscriptionRepo,
  FakeFolderRepo,
  FakeResourceRepo,
} from '../helpers/fakeRepos.js';
import { OrganizationResourceService } from '../../src/service/organizationResourceService.js';
import {
  EntityNotFoundError,
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
  const resourceRepo = new FakeResourceRepo();
  const folderRepo = new FakeFolderRepo(resourceRepo);
  const svc = new OrganizationResourceService(
    organizationRepo,
    organizationSubscriptionRepo,
    folderRepo,
    resourceRepo,
    async (fn) => fn({} as Queryable),
  );
  return { svc, organizationRepo, organizationSubscriptionRepo, folderRepo, resourceRepo, snapshot };
}

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
  return org;
}

const QUERY = { sql: 'select 1' };
const CT = (db: string) => ({ databaseType: db, host: 'localhost', port: 3306, database: 'db' });

describe('OrganizationResourceService folders', () => {
  it('creates and lists folders', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const root = await stack.svc.createFolder(org.id, 'Root');
    const child = await stack.svc.createFolder(org.id, 'Child', root.folderId);
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

    const folderInA = await stack.svc.createFolder(orgA.id, 'A');
    await expect(stack.svc.createFolder(orgB.id, 'X', folderInA.folderId)).rejects.toBeInstanceOf(EntityNotFoundError);

    const del = await stack.svc.createFolder(orgA.id, 'ToDelete');
    await stack.svc.deleteFolder(orgA.id, del.folderId);
    await expect(stack.svc.createFolder(orgA.id, 'X', del.folderId)).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('rejects moving a folder into itself or its own descendant (cycle)', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const a = await stack.svc.createFolder(org.id, 'A');
    const b = await stack.svc.createFolder(org.id, 'B', a.folderId);
    await expect(stack.svc.updateFolder(org.id, a.folderId, { parentId: a.folderId })).rejects.toBeInstanceOf(FolderMoveCycleError);
    await expect(stack.svc.updateFolder(org.id, a.folderId, { parentId: b.folderId })).rejects.toBeInstanceOf(FolderMoveCycleError);
  });

  it('rejects deleting a non-empty folder', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const folder = await stack.svc.createFolder(org.id, 'F');
    await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q', folderId: folder.folderId, content: QUERY }, 1);
    await expect(stack.svc.deleteFolder(org.id, folder.folderId)).rejects.toBeInstanceOf(FolderNotEmptyError);
    await stack.svc.createFolder(org.id, 'child', folder.folderId);
    await expect(stack.svc.deleteFolder(org.id, folder.folderId)).rejects.toBeInstanceOf(FolderNotEmptyError);
  });
});

describe('OrganizationResourceService resources', () => {
  it('creates resource at version 1 and lists summaries without content', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const created = await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q', content: QUERY }, 1);
    expect(created.version).toBe(1);
    const list = await stack.svc.listResources(org.id);
    expect(list).toHaveLength(1);
    expect((list[0] as any).content).toBeUndefined();
  });

  it('rejects disallowed engine with ORGANIZATION_FEATURE_REQUIRED', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    await expect(stack.svc.createResource(org.id, { resourceType: 'connection_template', name: 'c', content: CT('postgresql') }, 1))
      .rejects.toBeInstanceOf(OrganizationFeatureRequiredError);
  });

  it('enforces resource count quota', async () => {
    const stack = makeStack({ maxSharedResources: 2, sharedStorageQuotaBytes: 0, allowedTemplateDatabaseTypes: ['mysql'] });
    const org = await makeOrg(stack);
    await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q1', content: QUERY }, 1);
    await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q2', content: QUERY }, 1);
    await expect(stack.svc.createResource(org.id, { resourceType: 'query', name: 'q3', content: QUERY }, 1)).rejects.toBeInstanceOf(OrganizationQuotaExceededError);
  });

  it('0 = infinite skips quota dimension', async () => {
    const stack = makeStack({ maxSharedResources: 0, sharedStorageQuotaBytes: 0, allowedTemplateDatabaseTypes: ['mysql'] });
    const org = await makeOrg(stack);
    for (let i = 0; i < 10; i++) {
      await stack.svc.createResource(org.id, { resourceType: 'query', name: `q${i}`, content: QUERY }, 1);
    }
    expect(await stack.svc.listResources(org.id)).toHaveLength(10);
  });

  it('optimistic lock: update conflicts on stale baseVersion and bumps version', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const created = await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q', content: QUERY }, 1);
    await stack.svc.updateResource(org.id, created.resourceId, { baseVersion: 1, name: 'q2' }, 1);
    let conflict: unknown;
    try {
      await stack.svc.updateResource(org.id, created.resourceId, { baseVersion: 1, name: 'q3' }, 1);
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
    const created = await stack.svc.createResource(orgA.id, { resourceType: 'query', name: 'q', content: QUERY }, 1);
    await expect(stack.svc.getResource(orgB.id, created.resourceId)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('soft delete releases count quota immediately', async () => {
    const stack = makeStack({ maxSharedResources: 1, sharedStorageQuotaBytes: 0, allowedTemplateDatabaseTypes: ['mysql'] });
    const org = await makeOrg(stack);
    const created = await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q1', content: QUERY }, 1);
    await stack.svc.deleteResource(org.id, created.resourceId, 1);
    await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q2', content: QUERY }, 1);
  });

  it('moving a resource locks the target folder before the resource', async () => {
    const stack = makeStack();
    const org = await makeOrg(stack);
    const f1 = await stack.svc.createFolder(org.id, 'F1');
    const f2 = await stack.svc.createFolder(org.id, 'F2');
    const res = await stack.svc.createResource(org.id, { resourceType: 'query', name: 'q', folderId: f1.folderId, content: QUERY }, 1);

    const order: string[] = [];
    const folderRepo = stack.folderRepo as any;
    const resourceRepo = stack.resourceRepo as any;
    const origFolderLock = folderRepo.findByIdForUpdate.bind(folderRepo);
    const origResourceLock = resourceRepo.findByIdForUpdate.bind(resourceRepo);
    folderRepo.findByIdForUpdate = async (exec: unknown, orgId: number, id: number) => { order.push('folder'); return origFolderLock(exec, orgId, id); };
    resourceRepo.findByIdForUpdate = async (exec: unknown, orgId: number, id: number) => { order.push('resource'); return origResourceLock(exec, orgId, id); };

    await stack.svc.updateResource(org.id, res.resourceId, { baseVersion: 1, folderId: f2.folderId }, 1);

    expect(order.indexOf('folder')).toBeLessThan(order.indexOf('resource'));
    expect(order).toEqual(['folder', 'resource']);
  });
});