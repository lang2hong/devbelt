import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { refreshSession } from './session';
import { getAccessToken, setAccessToken } from './api/consoleAuth';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function refreshFlow(onRefresh: (n: number) => Promise<Response>) {
  let refreshCalls = 0;
  const fetchImpl = async (input: string): Promise<Response> => {
    if (input === '/api/console/auth/csrf') return new Response(null, { status: 204 });
    if (input === '/api/console/auth/refresh') {
      refreshCalls += 1;
      return onRefresh(refreshCalls);
    }
    throw new Error('unexpected ' + input);
  };
  const count = () => refreshCalls;
  return { fetchImpl, count };
}

const cookie = () => 'a=1; __Host-dbclient_csrf=tok';

beforeEach(() => setAccessToken(null));
afterEach(() => vi.unstubAllGlobals());

describe('refreshSession', () => {
  it('refreshes and returns ok, setting the token', async () => {
    const { fetchImpl, count } = refreshFlow(async () => jsonRes(200, { accessToken: 'new-tok' }));
    const r = await refreshSession(fetchImpl, cookie);
    expect(r).toEqual({ kind: 'ok' });
    expect(getAccessToken()).toBe('new-tok');
    expect(count()).toBe(1);
  });

  it('is single-flight for concurrent calls', async () => {
    const { fetchImpl, count } = refreshFlow(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return jsonRes(200, { accessToken: 't' });
    });
    const [a, b] = await Promise.all([refreshSession(fetchImpl, cookie), refreshSession(fetchImpl, cookie)]);
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    expect(count()).toBe(1);
  });

  it('resets inflight after settle (F3): a later call refreshes again', async () => {
    const { fetchImpl, count } = refreshFlow(async () => jsonRes(200, { accessToken: 't' }));
    await refreshSession(fetchImpl, cookie);
    await refreshSession(fetchImpl, cookie);
    expect(count()).toBe(2);
  });

  it('returns unauthorized when refresh is rejected with 401', async () => {
    const { fetchImpl } = refreshFlow(async () => jsonRes(401, { error: { code: 'UNAUTHORIZED' } }));
    const r = await refreshSession(fetchImpl, cookie);
    expect(r).toEqual({ kind: 'unauthorized' });
    expect(getAccessToken()).toBeNull();
  });

  it('returns failure when refresh throws', async () => {
    const { fetchImpl } = refreshFlow(async () => {
      throw new Error('network down');
    });
    const r = await refreshSession(fetchImpl, cookie);
    expect(r).toEqual({ kind: 'failure' });
  });

  it('serializes cross-tab refresh via Web Locks', async () => {
    const request = vi.fn(async (_name: string, cb: () => Promise<unknown>) => cb());
    vi.stubGlobal('navigator', { locks: { request } });
    const { fetchImpl } = refreshFlow(async () => jsonRes(200, { accessToken: 't' }));
    const r = await refreshSession(fetchImpl, cookie);
    expect(r.kind).toBe('ok');
    expect(request).toHaveBeenCalledWith('dbclient.console-refresh', expect.any(Function));
  });
});