import { describe, expect, it, beforeEach } from 'vitest';
import { authedFetch } from './authedFetch';
import { setAccessToken } from './consoleAuth';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Call = { url: string; auth: string | null; key: string | null };

beforeEach(() => setAccessToken(null));

describe('authedFetch (F1)', () => {
  it('replays once with a fresh token, preserving the idempotency key', async () => {
    setAccessToken('old');
    const calls: Call[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      const h = new Headers(init?.headers);
      calls.push({ url: input, auth: h.get('Authorization'), key: h.get('Idempotency-Key') });
      if (calls.length === 1) return jsonRes(401, { error: { code: 'UNAUTHORIZED' } });
      return jsonRes(200, { ok: true });
    };
    const refreshImpl = async () => {
      setAccessToken('new');
      return { kind: 'ok' as const };
    };

    const res = await authedFetch(
      '/api/x',
      { method: 'POST', headers: { Authorization: 'Bearer old', 'Idempotency-Key': 'k1' } },
      fetchImpl,
      refreshImpl,
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBe('Bearer old');
    expect(calls[1].auth).toBe('Bearer new');
    expect(calls[1].key).toBe('k1');
  });

  it('does not replay when refresh fails', async () => {
    setAccessToken('old');
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonRes(401, { error: { code: 'UNAUTHORIZED' } });
    };
    const refreshImpl = async () => ({ kind: 'unauthorized' as const });

    const res = await authedFetch('/api/x', { headers: { Authorization: 'Bearer old' } }, fetchImpl, refreshImpl);
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  it('passes through non-401 responses without refreshing', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonRes(200, { ok: true });
    };
    const res = await authedFetch('/api/x', {}, fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});