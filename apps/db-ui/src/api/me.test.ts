import { describe, expect, it, beforeEach } from 'vitest';
import { setAccessToken } from '@devbelt/auth-client';
import { me, updateDisplayName, changePassword } from './me';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => setAccessToken(null));

describe('me', () => {
  it('returns the console me payload', async () => {
    const body = {
      user: { userId: '1', email: 'a@b.com', displayName: null, emailVerified: true, status: 'active', lastLoginTime: null },
      platformAdmin: false,
      subscription: null,
    };
    const r = await me('tok', async () => jsonResponse(200, body));
    expect(r).toEqual({ kind: 'ok', value: body });
  });

  it('returns unauthorized without a token', async () => {
    const r = await me(null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });

  it('replays with a fresh token after a 401 (mid-session refresh)', async () => {
    const meBody = {
      user: { userId: '1', email: 'a@b.com', displayName: null, emailVerified: true, status: 'active', lastLoginTime: null },
      platformAdmin: false,
      subscription: null,
    };
    let meCalls = 0;
    const fetchImpl = async (input: string): Promise<Response> => {
      const url = input;
      if (url === '/api/console/me') {
        meCalls += 1;
        if (meCalls === 1) return jsonResponse(401, { error: { code: 'UNAUTHORIZED' } });
        return jsonResponse(200, meBody);
      }
      if (url === '/api/console/auth/csrf') return new Response(null, { status: 204 });
      if (url === '/api/console/auth/refresh') return jsonResponse(200, { accessToken: 'fresh' });
      throw new Error('unexpected ' + url);
    };
    const r = await me('stale', fetchImpl);
    expect(r).toEqual({ kind: 'ok', value: meBody });
    expect(meCalls).toBe(2);
  });
});

describe('updateDisplayName', () => {
  it('PATCHes /me with the caller-provided idempotency key and csrf', async () => {
    let captured: RequestInit | undefined;
    const r = await updateDisplayName('new', 'fixed-key-123', 'csrf-tok', 'tok', async (_url, init) => {
      captured = init;
      return jsonResponse(200, { user: { displayName: 'new' } });
    });
    expect(r).toEqual({ kind: 'ok', displayName: 'new' });
    expect(captured?.method).toBe('PATCH');
    const headers = captured?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('fixed-key-123');
    expect(headers['X-CSRF-Token']).toBe('csrf-tok');
  });

  it('returns unauthorized without a token', async () => {
    const r = await updateDisplayName('new', 'k', 'csrf', null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });

  it('maps 409 IDEMPOTENCY_IN_PROGRESS to in-progress', async () => {
    const r = await updateDisplayName('new', 'k', 'csrf', 'tok', async () => jsonResponse(409, { error: { code: 'IDEMPOTENCY_IN_PROGRESS' } }));
    expect(r).toEqual({ kind: 'in-progress' });
  });

  it('maps 409 IDEMPOTENCY_KEY_REUSED to conflict', async () => {
    const r = await updateDisplayName('new', 'k', 'csrf', 'tok', async () => jsonResponse(409, { error: { code: 'IDEMPOTENCY_KEY_REUSED' } }));
    expect(r).toEqual({ kind: 'conflict' });
  });
});

describe('changePassword', () => {
  it('returns relogin flag on success; no idempotency key', async () => {
    let captured: RequestInit | undefined;
    const r = await changePassword('cur', 'new', 'csrf-tok', 'tok', async (_url, init) => {
      captured = init;
      return jsonResponse(200, { ok: true, code: 'PASSWORD_CHANGED_RELOGIN_REQUIRED' });
    });
    expect(r).toEqual({ kind: 'ok', reloginRequired: true });
    const headers = captured?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
    expect(headers['X-CSRF-Token']).toBe('csrf-tok');
  });

  it('maps 401 to invalid-current-password', async () => {
    const r = await changePassword('bad', 'new', 'csrf-tok', 'tok', async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }));
    expect(r).toEqual({ kind: 'invalid-current-password' });
  });
});