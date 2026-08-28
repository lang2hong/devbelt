import { describe, it, expect } from 'vitest';
import { OrgCache } from '../../src/org/cache';
import type { FolderDto, ResourceSummaryDto, ResourceDetailDto } from '../../src/org/types';

function folder(id: string, parentId: string | null = null): FolderDto {
  return { folderId: id, name: `f${id}`, parentId };
}

function resource(id: string, folderId: string | null = null): ResourceSummaryDto {
  return { resourceId: id, resourceType: 'query', name: `r${id}`, folderId, version: 1, createdByMembershipId: '1', updatedByMembershipId: null };
}

function detail(id: string): ResourceDetailDto {
  return { ...resource(id), content: { sql: 'select 1' } };
}

describe('OrgCache', () => {
  it('partitions by userId:organizationId', () => {
    const cache = new OrgCache();
    cache.setResources('u1', 'org1', [resource('r1')]);
    cache.setResources('u1', 'org2', [resource('r2')]);
    cache.setResources('u2', 'org1', [resource('r3')]);

    expect(cache.getResources('u1', 'org1')?.map((r) => r.resourceId)).toEqual(['r1']);
    expect(cache.getResources('u1', 'org2')?.map((r) => r.resourceId)).toEqual(['r2']);
    expect(cache.getResources('u2', 'org1')?.map((r) => r.resourceId)).toEqual(['r3']);
    expect(cache.getResources('u2', 'org2')).toBeUndefined();
  });

  it('stores and retrieves resource details', () => {
    const cache = new OrgCache();
    cache.setDetail('u1', 'org1', detail('r1'));
    expect(cache.getDetail('u1', 'org1', 'r1')?.content).toEqual({ sql: 'select 1' });
    expect(cache.getDetail('u1', 'org1', 'r2')).toBeUndefined();
  });

  it('invalidates a single organization partition', () => {
    const cache = new OrgCache();
    cache.setResources('u1', 'org1', [resource('r1')]);
    cache.setResources('u1', 'org2', [resource('r2')]);

    expect(cache.invalidateOrg('u1', 'org1')).toBe(true);
    expect(cache.getResources('u1', 'org1')).toBeUndefined();
    expect(cache.getResources('u1', 'org2')).toHaveLength(1);
    expect(cache.invalidateOrg('u1', 'org1')).toBe(false);
  });

  it('invalidates a single resource (detail + summary entry)', () => {
    const cache = new OrgCache();
    cache.setResources('u1', 'org1', [resource('r1'), resource('r2')]);
    cache.setDetail('u1', 'org1', detail('r1'));

    expect(cache.invalidateResource('u1', 'org1', 'r1')).toBe(true);
    expect(cache.getDetail('u1', 'org1', 'r1')).toBeUndefined();
    expect(cache.getResources('u1', 'org1')?.map((r) => r.resourceId)).toEqual(['r2']);
  });

  it('clears all partitions for a user (logout/401) but not others', () => {
    const cache = new OrgCache();
    cache.setResources('u1', 'org1', [resource('r1')]);
    cache.setResources('u1', 'org2', [resource('r2')]);
    cache.setResources('u2', 'org1', [resource('r3')]);

    expect(cache.clearForUser('u1')).toBe(2);
    expect(cache.getResources('u1', 'org1')).toBeUndefined();
    expect(cache.getResources('u2', 'org1')).toHaveLength(1);
  });

  it('clearAll wipes everything', () => {
    const cache = new OrgCache();
    cache.setResources('u1', 'org1', [resource('r1')]);
    cache.setResources('u2', 'org1', [resource('r3')]);
    cache.clearAll();
    expect(cache.size).toBe(0);
  });

  it('stores folders', () => {
    const cache = new OrgCache();
    cache.setFolders('u1', 'org1', [folder('f1')]);
    expect(cache.getFolders('u1', 'org1')?.map((f) => f.folderId)).toEqual(['f1']);
  });
});