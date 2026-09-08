import { describe, expect, it, beforeEach } from 'vitest';
import {
  getAccessToken,
  setAccessToken,
  getOrCreateDeviceKey,
  login,
  refresh,
  me,
  ensureCsrf,
  type FetchLike,
} from './consoleAuth';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => setAccessToken(null));

describe('getOrCreateDeviceKey', () => {
  it('persists and reuses a generated device key', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const first = getOrCreateDeviceKey(storage as any);
    const second = getOrCreateDeviceKey(storage as any);
    expect(first).toBeTruthy();
    expect(first).toBe(second);
  });
});

describe('login', () => {
  it('stores the access token in memory on success', async () => {
    const r = await login('a@b.com', 'p', 'dk', 'csrf', async () => jsonResponse(200, { accessToken: 'tok-1', user: { userId: '1', email: 'a@b.com', displayName: null } }));
    expect(r.kind).toBe('ok');
    expect(getAccessToken()).toBe('tok-1');
  });

  it('maps 401 to invalid-credentials', async () => {
    const r = await login('a@b.com', 'p', 'dk', 'csrf', async () => jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS' } }));
    expect(r).toEqual({ kind: 'invalid-credentials' });
    expect(getAccessToken()).toBeNull();
  });

  it('maps 429 to rate-limited', async () => {
    const r = await login('a@b.com', 'p', 'dk', 'csrf', async () => jsonResponse(429, { error: { code: 'TOO_MANY_REQUESTS' } }));
    expect(r).toEqual({ kind: 'rate-limited' });
  });
});

describe('refresh', () => {
  it('updates the in-memory token on success', async () => {
    const r = await refresh('csrf', async () => jsonResponse(200, { accessToken: 'tok-2' }));
    expect(r.kind).toBe('ok');
    expect(getAccessToken()).toBe('tok-2');
  });

  it('clears the token on 401', async () => {
    setAccessToken('old');
    const r = await refresh('csrf', async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }));
    expect(r.kind).toBe('invalid-credentials');
    expect(getAccessToken()).toBeNull();
  });
});

describe('me', () => {
  it('returns the console me payload', async () => {
    const body = { user: { userId: '1', email: 'a@b.com', displayName: null }, platformAdmin: false, organizations: [] };
    const r = await me('tok', async () => jsonResponse(200, body));
    expect(r).toEqual({ kind: 'ok', value: body });
  });

  it('returns unauthorized without a token', async () => {
    const r = await me(null, (() => { throw new Error('unreachable'); }) as FetchLike);
    expect(r).toEqual({ kind: 'unauthorized' });
  });
});

describe('ensureCsrf', () => {
  it('reads the csrf token from cookies', async () => {
    const r = await ensureCsrf(async () => jsonResponse(204, null), () => 'a=1; __Host-dbclient_csrf=abc; b=2');
    expect(r).toBe('abc');
  });
});