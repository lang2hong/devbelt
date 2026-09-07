import { describe, expect, it } from 'vitest';
import { confirmEmail, verificationUrlPath, type ConfirmEmailFetch } from './verifyEmail';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okFetch(status: number, body: unknown): ConfirmEmailFetch {
  return async () => jsonResponse(body, status);
}

describe('verificationUrlPath', () => {
  it('encodes the token into the path segment', () => {
    expect(verificationUrlPath('a/b c+d')).toBe('/api/auth/email-verifications/a%2Fb%20c%2Bd/confirm');
  });
});

describe('confirmEmail', () => {
  it('resolves success on HTTP 200 with { ok: true }', async () => {
    const r = await confirmEmail('tok', { fetchImpl: okFetch(200, { ok: true }) });
    expect(r).toEqual({ kind: 'success' });
  });

  it('resolves invalid on HTTP 401', async () => {
    const r = await confirmEmail('tok', {
      fetchImpl: okFetch(401, { message: 'invalid or expired verification token', code: 'UNAUTHORIZED' }),
    });
    expect(r).toEqual({ kind: 'invalid' });
  });

  it('resolves failure on HTTP 500', async () => {
    const r = await confirmEmail('tok', { fetchImpl: okFetch(500, { message: 'Internal server error' }) });
    expect(r.kind).toBe('failure');
  });

  it('resolves failure on non-JSON success body', async () => {
    const r = await confirmEmail('tok', {
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
    });
    expect(r.kind).toBe('failure');
  });

  it('resolves failure on unexpected success payload', async () => {
    const r = await confirmEmail('tok', { fetchImpl: okFetch(200, { nope: true }) });
    expect(r.kind).toBe('failure');
  });

  it('resolves failure when fetch throws', async () => {
    const r = await confirmEmail('tok', {
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    expect(r.kind).toBe('failure');
  });

  it('POSTs to the API path with method POST', async () => {
    let calledUrl = '';
    let calledInit: RequestInit | undefined;
    await confirmEmail('tok', {
      baseUrl: 'http://localhost:3000',
      fetchImpl: async (url, init) => {
        calledUrl = url;
        calledInit = init;
        return jsonResponse({ ok: true }, 200);
      },
    });
    expect(calledUrl).toBe('http://localhost:3000/api/auth/email-verifications/tok/confirm');
    expect(calledInit?.method).toBe('POST');
  });
});