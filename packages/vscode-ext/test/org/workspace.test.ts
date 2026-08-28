import { describe, it, expect, vi } from 'vitest';
import { OrgClient } from '../../src/org/client';
import { OrgWorkspace } from '../../src/org/workspace';
import { CredentialVault } from '../../src/org/credentialVault';

interface Route { status: number; body: unknown }
type Handler = (method: string, path: string, body?: unknown) => Route;

function makeWorkspace(handler: Handler) {
  const requestRaw = vi.fn((m: string, p: string, b?: unknown) => Promise.resolve(handler(m, p, b)));
  const client = new OrgClient({ requestRaw });
  const vault = new CredentialVault({ get: async () => undefined, store: async () => {}, delete: async () => {} } as any);
  const workspace = new OrgWorkspace(client, vault);
  return { workspace, requestRaw };
}

const me = () => ({ status: 200, body: { user: { userId: 'u1', email: 'a@b.c', status: 'active' } } });

describe('OrgWorkspace (错误驱动的缓存失效，§6.2)', () => {
  it('caches folder and resource lists per organization', async () => {
    let folderCalls = 0;
    let resourceCalls = 0;
    const { workspace, requestRaw } = makeWorkspace((_m, p) => {
      if (p === '/api/me') return me();
      if (p === '/api/organizations/org1/folders') { folderCalls++; return { status: 200, body: { folders: [{ folderId: 'f1', name: 'F', parentId: null }] } }; }
      if (p === '/api/organizations/org1/resources') { resourceCalls++; return { status: 200, body: { resources: [{ resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null }] } }; }
      return { status: 200, body: {} };
    });

    await workspace.listFolders('org1');
    await workspace.listFolders('org1');
    await workspace.listResources('org1');
    await workspace.listResources('org1');

    expect(folderCalls).toBe(1);
    expect(resourceCalls).toBe(1);
    expect(requestRaw).toHaveBeenCalled();
  });

  it('401 → clearAuth: 清认证并回退 personal，缓存清空', async () => {
    let unauthorized = false;
    const { workspace } = makeWorkspace((_m, p) => {
      if (p === '/api/me') return me();
      if (p === '/api/organizations/org1/resources' && unauthorized) return { status: 401, body: { code: 'UNAUTHORIZED' } };
      if (p === '/api/organizations/org1/resources') return { status: 200, body: { resources: [{ resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null }] } };
      return { status: 200, body: {} };
    });

    await workspace.listResources('org1');
    workspace.select({ kind: 'organization', organizationId: 'org1', role: 'member' });
    expect(workspace.visibleCache.size).toBe(1);

    unauthorized = true;
    await expect(workspace.listResources('org1', true)).rejects.toThrow();

    expect(workspace.visibleCache.size).toBe(0);
    expect(workspace.workspace).toEqual({ kind: 'personal' });
  });

  it('404 RESOURCE_NOT_FOUND → invalidateResource（仅该资源）', async () => {
    let detail404 = false;
    const { workspace } = makeWorkspace((_m, p) => {
      if (p === '/api/me') return me();
      if (p === '/api/organizations/org1/resources') return { status: 200, body: { resources: [{ resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null }, { resourceId: 'r2', resourceType: 'query', name: 'q2', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null }] } };
      if (p === '/api/organizations/org1/resources/r1' && detail404) return { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } };
      if (p === '/api/organizations/org1/resources/r1') return { status: 200, body: { resource: { resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null, content: { sql: 'select 1' } } } };
      return { status: 200, body: {} };
    });

    await workspace.listResources('org1');
    await workspace.getResource('org1', 'r1');
    expect(workspace.visibleCache.getDetail('u1', 'org1', 'r1')).toBeTruthy();

    detail404 = true;
    await expect(workspace.getResource('org1', 'r1', true)).rejects.toThrow();
    // 该资源 detail 被驱逐，列表里只剩 r2
    expect(workspace.visibleCache.getDetail('u1', 'org1', 'r1')).toBeUndefined();
    expect(workspace.visibleCache.getResources('u1', 'org1')?.map((r) => r.resourceId)).toEqual(['r2']);
  });

  it('403 / 404 组织级 → invalidateOrg（整组织驱逐）', async () => {
    let forbid = false;
    const { workspace } = makeWorkspace((_m, p) => {
      if (p === '/api/me') return me();
      if (p === '/api/organizations/org1/resources') return { status: 200, body: { resources: [{ resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null }] } };
      if (p === '/api/organizations/org1/folders' && forbid) return { status: 403, body: { code: 'FORBIDDEN' } };
      if (p === '/api/organizations/org1/folders') return { status: 200, body: { folders: [] } };
      return { status: 200, body: {} };
    });

    await workspace.listResources('org1');
    expect(workspace.visibleCache.getResources('u1', 'org1')).toBeTruthy();

    forbid = true;
    await expect(workspace.listFolders('org1', true)).rejects.toThrow();
    expect(workspace.visibleCache.getResources('u1', 'org1')).toBeUndefined();
  });

  it('409 版本冲突 → 不驱逐缓存，currentVersion 抛出', async () => {
    const { workspace } = makeWorkspace((m, p) => {
      if (p === '/api/me') return me();
      if (p === '/api/organizations/org1/resources') return { status: 200, body: { resources: [{ resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null }] } };
      if (p === '/api/organizations/org1/resources/r1' && m === 'PATCH') return { status: 409, body: { code: 'RESOURCE_VERSION_CONFLICT', message: 'stale', currentVersion: 9 } };
      return { status: 200, body: {} };
    });

    await workspace.listResources('org1');
    await expect(
      workspace.updateResource('org1', 'r1', { baseVersion: 1, content: { sql: 'select 2' } }),
    ).rejects.toSatisfy((e: unknown) => (e as any).currentVersion === 9);

    // 409 不清缓存：列表仍在（本地编辑保留，供冲突处理）
    expect(workspace.visibleCache.getResources('u1', 'org1')).toBeTruthy();
    expect(workspace.workspace.kind).toBe('personal'); // 未被错误清认证
  });

  it('成员状态/角色变更 → invalidateOrganization 立即失效并触发重拉', async () => {
    let resourceCalls = 0;
    const { workspace } = makeWorkspace((_m, p) => {
      if (p === '/api/me') return me();
      if (p === '/api/organizations/org1/resources') { resourceCalls++; return { status: 200, body: { resources: [] } }; }
      return { status: 200, body: {} };
    });

    await workspace.listResources('org1');
    expect(resourceCalls).toBe(1);

    // 成员角色变更：invalidateOrganization
    workspace.invalidateOrganization('org1');
    await workspace.listResources('org1');
    expect(resourceCalls).toBe(2);
  });

  it('登出事件（AuthEvent logout）由 clearAuth 清空全部', async () => {
    const { workspace } = makeWorkspace((_m, p) => {
      if (p === '/api/me') return me();
      if (p === '/api/organizations/org1/resources') return { status: 200, body: { resources: [{ resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null }] } };
      return { status: 200, body: {} };
    });
    await workspace.listResources('org1');
    workspace.select({ kind: 'organization', organizationId: 'org1', role: 'member' });
    expect(workspace.visibleCache.size).toBe(1);

    workspace.clearAuth();
    expect(workspace.visibleCache.size).toBe(0);
    expect(workspace.workspace).toEqual({ kind: 'personal' });
  });
});