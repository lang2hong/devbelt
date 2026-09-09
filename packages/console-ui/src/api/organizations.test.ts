import { describe, expect, it } from 'vitest';
import {
  listOrganizations,
  createOrganization,
  getOrganization,
  assignRole,
  inviteMember,
  listFolders,
  listResources,
} from './organizations';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const org = { organizationId: '1', name: 'Acme', status: 'active', closedTime: null, role: 'admin' };

describe('listOrganizations', () => {
  it('returns organizations', async () => {
    const r = await listOrganizations('tok', async () => jsonRes(200, { organizations: [org] }));
    expect(r).toEqual({ kind: 'ok', value: [org] });
  });

  it('returns unauthorized without a token', async () => {
    const r = await listOrganizations(null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });
});

describe('createOrganization', () => {
  it('POSTs with CSRF, bearer and the caller-provided idempotency key', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const r = await createOrganization('Acme', 'fixed-key', 'csrf-tok', 'at', async (url, init) => {
      captured = { url: String(url), init };
      return jsonRes(201, { organization: org });
    });
    expect(r).toEqual({ kind: 'ok', value: org });
    expect(captured.url).toBe('/api/organizations');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('fixed-key');
    expect(headers['X-CSRF-Token']).toBe('csrf-tok');
    expect(headers.Authorization).toBe('Bearer at');
  });
});

describe('getOrganization', () => {
  it('returns the organization detail', async () => {
    const r = await getOrganization('1', 'tok', async () => jsonRes(200, { organization: org }));
    expect(r).toEqual({ kind: 'ok', value: org });
  });

  it('maps 404 to not-found', async () => {
    const r = await getOrganization('1', 'tok', async () => jsonRes(404, { error: { code: 'ORGANIZATION_NOT_FOUND' } }));
    expect(r).toEqual({ kind: 'not-found' });
  });
});

describe('org writes carry the caller idempotency key', () => {
  it('assignRole sends the provided key', async () => {
    let headers: Record<string, string> = {};
    await assignRole('1', 'm1', 'admin', 'fixed-key', 'csrf-tok', 'at', async (_url, init) => {
      headers = init?.headers as Record<string, string>;
      return jsonRes(200, { ok: true });
    });
    expect(headers['Idempotency-Key']).toBe('fixed-key');
  });

  it('inviteMember sends the provided key and JSON body', async () => {
    let captured: { init?: RequestInit } = {};
    const r = await inviteMember('1', 'a@b.com', 'member', 'fixed-key', 'csrf-tok', 'at', async (_url, init) => {
      captured = { init };
      return jsonRes(201, { invitation: { invitationId: '9', email: 'a@b.com', role: 'member', expiresTime: '2026-01-02T00:00:00.000Z' } });
    });
    expect(r.kind).toBe('ok');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('fixed-key');
    expect(captured.init?.body).toBe(JSON.stringify({ email: 'a@b.com', role: 'member' }));
  });
});

describe('folder/resource metadata (read-only)', () => {
  it('listFolders hits the folders list URL and returns metadata only', async () => {
    let url = '';
    const r = await listFolders('1', 'tok', async (u) => {
      url = String(u);
      return jsonRes(200, { folders: [{ folderId: '2', name: 'A', parentId: null }] });
    });
    expect(url).toBe('/api/organizations/1/folders');
    expect(r).toEqual({ kind: 'ok', value: [{ folderId: '2', name: 'A', parentId: null }] });
  });

  it('listResources hits the resources list URL and never exposes content', async () => {
    const summary = {
      resourceId: '5',
      resourceType: 'connection',
      name: 'prod',
      folderId: null,
      version: 3,
      createdByMembershipId: '7',
      updatedByMembershipId: null,
    };
    let url = '';
    const r = await listResources('1', 'tok', async (u) => {
      url = String(u);
      return jsonRes(200, { resources: [summary] });
    });
    expect(url).toBe('/api/organizations/1/resources');
    expect(r.kind).toBe('ok');
    const value = r.kind === 'ok' ? r.value : [];
    expect(value[0]).toEqual(summary);
    for (const key of Object.keys(value[0])) {
      expect(['content', 'ciphertext', 'ciphertextBytes', 'encrypted', 'e2ee', 'material', 'payload']).not.toContain(key);
    }
  });

  it('maps 403 (resource.read not granted / aud narrowing) to forbidden', async () => {
    const r = await listResources('1', 'tok', async () => jsonRes(403, { error: { code: 'FORBIDDEN' } }));
    expect(r).toEqual({ kind: 'forbidden' });
  });
});

describe('409 idempotency semantics', () => {
  it('maps IDEMPOTENCY_IN_PROGRESS to retryable in-progress', async () => {
    const r = await createOrganization('Acme', 'k', 'csrf', 'at', async () => jsonRes(409, { code: 'IDEMPOTENCY_IN_PROGRESS' }));
    expect(r).toEqual({ kind: 'in-progress' });
  });

  it('maps IDEMPOTENCY_KEY_REUSED to non-retryable conflict', async () => {
    const r = await createOrganization('Acme', 'k', 'csrf', 'at', async () => jsonRes(409, { code: 'IDEMPOTENCY_KEY_REUSED' }));
    expect(r).toEqual({ kind: 'conflict' });
  });

  it('maps a 409 without a JSON idempotency code to conflict', async () => {
    const r = await createOrganization('Acme', 'k', 'csrf', 'at', async () => jsonRes(409, { message: 'conflict' }));
    expect(r).toEqual({ kind: 'conflict' });
  });
});