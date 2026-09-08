import { describe, expect, it } from 'vitest';
import { claimLinkFlow, verifyEmail, resendVerification, type FetchLike } from './linkFlows';
import { readCsrfToken } from './csrf';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('claimLinkFlow', () => {
  it('resolves ok on HTTP 200', async () => {
    const r = await claimLinkFlow('verify-email', 'a'.repeat(43), async () => jsonResponse(200, { ok: true }));
    expect(r).toEqual({ kind: 'ok' });
  });

  it('resolves invalid on HTTP 422', async () => {
    const r = await claimLinkFlow('verify-email', 'a'.repeat(43), async () => jsonResponse(422, { error: { code: 'VALIDATION_FAILED' } }));
    expect(r).toEqual({ kind: 'invalid' });
  });

  it('resolves failure on HTTP 500', async () => {
    const r = await claimLinkFlow('verify-email', 'a'.repeat(43), async () => jsonResponse(500, { error: { code: 'INTERNAL' } }));
    expect(r).toEqual({ kind: 'failure' });
  });

  it('resolves failure when fetch throws', async () => {
    const r = await claimLinkFlow('verify-email', 'a'.repeat(43), async () => {
      throw new Error('network');
    });
    expect(r).toEqual({ kind: 'failure' });
  });

  it('posts JSON body with type and token and Accept header', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const fetchImpl: FetchLike = async (input, i) => {
      url = input;
      init = i;
      return jsonResponse(200, { ok: true });
    };
    await claimLinkFlow('verify-email', 'tok', fetchImpl);
    expect(url).toBe('/api/public/link-flows');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ type: 'verify-email', token: 'tok' });
    expect((init?.headers as Record<string, string>).Accept).toBe('application/json');
  });
});

describe('verifyEmail', () => {
  it('resolves success on HTTP 200', async () => {
    const r = await verifyEmail('csrf', async () => jsonResponse(200, { ok: true }));
    expect(r).toEqual({ kind: 'success' });
  });

  it('resolves already-confirmed on HTTP 409', async () => {
    const r = await verifyEmail('csrf', async () => jsonResponse(409, { error: { code: 'EMAIL_VERIFICATION_ALREADY_CONFIRMED' } }));
    expect(r).toEqual({ kind: 'already-confirmed' });
  });

  it('resolves invalid on HTTP 401', async () => {
    const r = await verifyEmail('csrf', async () => jsonResponse(401, { error: { code: 'EMAIL_VERIFICATION_INVALID' } }));
    expect(r).toEqual({ kind: 'invalid' });
  });

  it('resolves failure on network error', async () => {
    const r = await verifyEmail('csrf', async () => {
      throw new Error('network');
    });
    expect(r).toEqual({ kind: 'failure' });
  });

  it('sends the csrf token as X-CSRF-Token header', async () => {
    let init: RequestInit | undefined;
    await verifyEmail('the-csrf-token', async (_input, i) => {
      init = i;
      return jsonResponse(200, { ok: true });
    });
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('the-csrf-token');
  });
});

describe('resendVerification', () => {
  it('resolves ok on HTTP 200', async () => {
    const r = await resendVerification('x@b.com', 'csrf', async () => jsonResponse(200, { ok: true }));
    expect(r).toEqual({ kind: 'ok' });
  });

  it('resolves rate-limited on 429 with Retry-After', async () => {
    const r = await resendVerification('x@b.com', 'csrf', async () => jsonResponse(429, { error: { code: 'TOO_MANY_REQUESTS' } }, { 'Retry-After': '42' }));
    expect(r).toEqual({ kind: 'rate-limited', retryAfter: 42 });
  });

  it('resolves failure on network error', async () => {
    const r = await resendVerification('x@b.com', 'csrf', async () => {
      throw new Error('network');
    });
    expect(r).toEqual({ kind: 'failure' });
  });
});

describe('readCsrfToken', () => {
  it('reads the production prefixed cookie name', () => {
    expect(readCsrfToken('a=1; __Host-dbclient_csrf=abc; b=2')).toBe('abc');
  });

  it('reads the dev cookie name', () => {
    expect(readCsrfToken('dev_dbcsrf=xyz')).toBe('xyz');
  });

  it('returns null when absent', () => {
    expect(readCsrfToken('a=1')).toBeNull();
    expect(readCsrfToken('')).toBeNull();
  });
});