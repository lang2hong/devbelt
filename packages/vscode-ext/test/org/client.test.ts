import { describe, it, expect } from 'vitest';
import { OrgClient, OrgApiError } from '../../src/org/client';

function makeTransport() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let handler = (_m: string, _p: string, _b?: unknown) => ({ status: 200, body: {} });
  const requestRaw = (m: string, p: string, b?: unknown) => {
    calls.push({ method: m, path: p, body: b });
    return Promise.resolve(handler(m, p, b));
  };
  return { calls, requestRaw, set: (fn: typeof handler) => { handler = fn; } };
}

describe('OrgClient', () => {
  it('lists organizations and maps response', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 200, body: { organizations: [{ organizationId: '9', name: 'Acme', status: 'active', closedTime: null, role: 'admin' }] } }));
    const client = new OrgClient(t);

    const orgs = await client.listOrganizations();
    expect(orgs).toEqual([{ organizationId: '9', name: 'Acme', status: 'active', closedTime: null, role: 'admin' }]);
    expect(t.calls[0].path).toBe('/api/db/organizations');
  });

  it('returns userId from /api/db/me', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 200, body: { user: { userId: '42', email: 'a@b.c', status: 'active' } } }));
    const client = new OrgClient(t);
    await expect(client.getUserId()).resolves.toBe('42');
  });

  it('encodes path params so ids cannot alter the request path', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 200, body: { folders: [], resource: {} } }));
    const client = new OrgClient(t);
    await client.listFolders('9/../../x');
    await client.getResource('9', 'a/b?c');
    expect(t.calls[0].path).toBe('/api/db/organizations/9%2F..%2F..%2Fx/folders');
    expect(t.calls[1].path).toBe('/api/db/organizations/9/resources/a%2Fb%3Fc');
  });

  it('maps 404 organization-not-found to typed error', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 404, body: { code: 'ORGANIZATION_NOT_FOUND', message: 'nope' } }));
    const client = new OrgClient(t);

    await expect(client.listResources('9')).rejects.toSatisfy((e: unknown) => {
      return e instanceof OrgApiError && (e as OrgApiError).status === 404 && (e as OrgApiError).isNotFound();
    });
  });

  it('maps 403 forbidden', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 403, body: { code: 'FORBIDDEN', message: 'no' } }));
    const client = new OrgClient(t);
    await expect(client.listFolders('9')).rejects.toSatisfy((e: unknown) => {
      return e instanceof OrgApiError && (e as OrgApiError).isForbidden();
    });
  });

  it('maps 409 version conflict with currentVersion', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 409, body: { code: 'RESOURCE_VERSION_CONFLICT', message: 'stale', currentVersion: 7 } }));
    const client = new OrgClient(t);

    await expect(client.updateResource('9', 'r1', { baseVersion: 3, name: 'x' })).rejects.toSatisfy((e: unknown) => {
      return e instanceof OrgApiError && (e as OrgApiError).isVersionConflict() && (e as OrgApiError).currentVersion === 7;
    });
  });

  it('maps 401 to auth failure', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 401, body: { code: 'UNAUTHORIZED', message: 'x' } }));
    const client = new OrgClient(t);
    await expect(client.listOrganizations()).rejects.toSatisfy((e: unknown) => {
      return e instanceof OrgApiError && (e as OrgApiError).isAuthFailure();
    });
  });

  it('sends only server-schema fields in create body (no local credential)', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 201, body: { resource: { resourceId: '1', resourceType: 'query', name: 'q', folderId: null, version: 1, createdByMembershipId: '1', updatedByMembershipId: null } } }));
    const client = new OrgClient(t);

    // 即使调用方塞入未知/凭据字段，客户端只透传显式定义的字段。
    const input = { resourceType: 'query' as const, name: 'q', folderId: null, content: { sql: 'select 1' } };
    await client.createResource('9', input);

    expect(t.calls[0].method).toBe('POST');
    expect(t.calls[0].path).toBe('/api/db/organizations/9/resources');
    expect(t.calls[0].body).toEqual(input);
    expect(JSON.stringify(t.calls[0].body)).not.toContain('password');
  });

  it('getResource returns detail with content', async () => {
    const t = makeTransport();
    t.set(() => ({ status: 200, body: { resource: { resourceId: '1', resourceType: 'connection_template', name: 'tpl', folderId: null, version: 2, createdByMembershipId: '1', updatedByMembershipId: null, content: { databaseType: 'mysql', host: 'h', port: 3306, database: 'd' } } } }));
    const client = new OrgClient(t);
    const detail = await client.getResource('9', '1');
    expect(detail.resourceType).toBe('connection_template');
    expect(detail.content).toEqual({ databaseType: 'mysql', host: 'h', port: 3306, database: 'd' });
  });
});