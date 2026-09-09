import { describe, expect, it } from 'vitest';
import {
  listUsers,
  setUserStatus,
  adjustUserSubscription,
  listOrganizations,
  adjustOrganizationSubscription,
  queryAudit,
  exportAudit,
} from './admin';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function textRes(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/csv' } });
}

const user = { userId: '1', email: 'a@b.com', emailVerified: true, displayName: null, status: 'active', role: 'user', lastLoginTime: null, planCode: 'free', deviceCount: 1, subscriptionVersion: 0, periodEndTime: null, createTime: '2026-01-01T00:00:00.000Z' };

describe('listUsers', () => {
  it('hits the admin users URL with filters', async () => {
    let url = '';
    const r = await listUsers({ emailExact: 'a@b.com' }, 'tok', async (u) => {
      url = String(u);
      return jsonRes(200, { items: [user], nextCursor: null });
    });
    expect(url).toContain('/api/console/admin/users?');
    expect(url).toContain('emailExact=a%40b.com');
    expect(r).toEqual({ kind: 'ok', value: { items: [user], nextCursor: null } });
  });

  it('returns unauthorized without a token', async () => {
    const r = await listUsers({}, null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });
});

describe('setUserStatus', () => {
  it('PATCHes status with idempotency key, csrf and reason', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const r = await setUserStatus('5', 'disabled', 'abuse', 'key-1', 'csrf', 'tok', async (url, init) => {
      captured = { url: String(url), init };
      return jsonRes(200, { user: { userId: '5', status: 'disabled' } });
    });
    expect(r).toEqual({ kind: 'ok', value: { userId: '5', status: 'disabled' } });
    expect(captured.url).toBe('/api/console/admin/users/5/status');
    expect(captured.init?.method).toBe('PATCH');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('key-1');
    expect(headers['X-CSRF-Token']).toBe('csrf');
    expect(captured.init?.body).toBe(JSON.stringify({ status: 'disabled', reason: 'abuse' }));
  });
});

describe('adjustUserSubscription', () => {
  it('omits null periodEndTime from body', async () => {
    let body = '';
    const r = await adjustUserSubscription('5', { planCode: 'pro', periodEndTime: null, reason: 'upgrade', expectedVersion: 0 }, 'key-1', 'csrf', 'tok', async (_u, init) => {
      body = String(init?.body);
      return jsonRes(200, { subscriptionVersion: 1 });
    });
    expect(r.kind).toBe('ok');
    expect(JSON.parse(body)).toEqual({ planCode: 'pro', reason: 'upgrade', expectedVersion: 0 });
  });
});

describe('listOrganizations', () => {
  it('hits the admin organizations URL', async () => {
    let url = '';
    await listOrganizations({ namePrefix: 'Ac', status: 'active' }, 'tok', async (u) => {
      url = String(u);
      return jsonRes(200, { items: [], nextCursor: null });
    });
    expect(url).toContain('/api/console/admin/organizations?');
    expect(url).toContain('namePrefix=Ac');
    expect(url).toContain('status=active');
  });
});

describe('adjustOrganizationSubscription', () => {
  it('PATCHes org subscription with seatLimit', async () => {
    let captured: { url?: string; body?: string } = {};
    const r = await adjustOrganizationSubscription('9', { planCode: 'organization_free', seatLimit: 10, periodEndTime: null, reason: 'scale', expectedVersion: 2 }, 'key-1', 'csrf', 'tok', async (url, init) => {
      captured = { url: String(url), body: String(init?.body) };
      return jsonRes(200, { subscriptionVersion: 3 });
    });
    expect(r).toEqual({ kind: 'ok', value: { subscriptionVersion: 3 } });
    expect(captured.url).toBe('/api/console/admin/organizations/9/subscription');
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ planCode: 'organization_free', seatLimit: 10, reason: 'scale', expectedVersion: 2 });
  });
});

describe('queryAudit', () => {
  it('hits the audit query URL with time filters', async () => {
    let url = '';
    await queryAudit({ eventType: 'auth.login.success', fromTime: '2026-01-01T00:00:00.000Z' }, 'tok', async (u) => {
      url = String(u);
      return jsonRes(200, { items: [], nextCursor: null });
    });
    expect(url).toContain('/api/console/admin/audit?');
    expect(url).toContain('eventType=auth.login.success');
  });
});

describe('exportAudit', () => {
  it('POSTs export with idempotency key and returns text', async () => {
    let captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const r = await exportAudit('csv', { eventType: 'auth.login.failed' }, 'key-1', 'csrf', 'tok', async (url, init) => {
      captured = { url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) };
      return textRes(200, 'a,b\n1,2');
    });
    expect(r).toEqual({ kind: 'ok', value: 'a,b\n1,2' });
    expect(captured.url).toBe('/api/console/admin/audit/exports');
    expect(captured.headers?.['Idempotency-Key']).toBe('key-1');
    expect(JSON.parse(captured.body ?? '{}')).toEqual({ format: 'csv', filters: { eventType: 'auth.login.failed' } });
  });
});