import { describe, expect, it } from 'vitest';
import { claimLinkFlow, verifyEmail, resendVerification, bindMailFlow, createSyncResetHandoff, type FetchLike } from './linkFlows';
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

describe('bindMailFlow', () => {
  it('resolves ok on HTTP 200', async () => {
    const r = await bindMailFlow('csrf', 'token', async () => jsonResponse(200, { ok: true }));
    expect(r).toEqual({ kind: 'ok' });
  });

  it('resolves invalid on HTTP 400', async () => {
    const r = await bindMailFlow('csrf', 'token', async () => jsonResponse(400, { error: { code: 'INVITATION_INVALID' } }));
    expect(r).toEqual({ kind: 'invalid' });
  });

  it('resolves unauthorized on HTTP 401', async () => {
    const r = await bindMailFlow('csrf', 'token', async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }));
    expect(r).toEqual({ kind: 'unauthorized' });
  });

  it('sends bearer + csrf headers', async () => {
    let url = '';
    let init: RequestInit | undefined;
    await bindMailFlow('the-csrf', 'the-token', async (input, i) => {
      url = input;
      init = i;
      return jsonResponse(200, { ok: true });
    });
    const headers = init?.headers as Record<string, string>;
    expect(url).toBe('/api/console/link-flows/bind');
    expect(headers.Authorization).toBe('Bearer the-token');
    expect(headers['X-CSRF-Token']).toBe('the-csrf');
  });

  it('resolves failure on HTTP 500', async () => {
    const r = await bindMailFlow('csrf', 'token', async () => jsonResponse(500, { error: { code: 'INTERNAL' } }));
    expect(r).toEqual({ kind: 'failure' });
  });
});

describe('readCsrfToken', () => {
  it('reads the production prefixed cookie name', () => {
    expect(readCsrfToken('a=1; __Host-devbelt_csrf=abc; b=2')).toBe('abc');
  });

  it('reads the dev cookie name', () => {
    expect(readCsrfToken('dev_devbelt_csrf=xyz')).toBe('xyz');
  });

  it('returns null when absent', () => {
    expect(readCsrfToken('a=1')).toBeNull();
    expect(readCsrfToken('')).toBeNull();
  });
});

describe('createSyncResetHandoff', () => {
  it('resolves success with openUri and expiresTime on HTTP 200', async () => {
    const r = await createSyncResetHandoff('csrf', 'token', async () =>
      jsonResponse(200, { openUri: 'vscode://devbelt.sync/reset-after-loss?handoffTicket=abc', expiresTime: '2026-09-09T00:00:00.000Z' }),
    );
    expect(r).toEqual({ kind: 'success', openUri: 'vscode://devbelt.sync/reset-after-loss?handoffTicket=abc', expiresTime: '2026-09-09T00:00:00.000Z' });
  });

  it('resolves invalid on HTTP 400', async () => {
    const r = await createSyncResetHandoff('csrf', 'token', async () => jsonResponse(400, { error: { code: 'SYNC_RESET_HANDOFF_INVALID' } }));
    expect(r).toEqual({ kind: 'invalid' });
  });

  it('resolves unauthorized on HTTP 401 and 403', async () => {
    const r401 = await createSyncResetHandoff('csrf', 'token', async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED' } }));
    expect(r401).toEqual({ kind: 'unauthorized' });
    const r403 = await createSyncResetHandoff('csrf', 'token', async () => jsonResponse(403, { error: { code: 'FORBIDDEN' } }));
    expect(r403).toEqual({ kind: 'unauthorized' });
  });

  it('resolves rate-limited with Retry-After, falling back to 60 on missing/non-numeric', async () => {
    const withHeader = await createSyncResetHandoff('csrf', 'token', async () => jsonResponse(429, { error: { code: 'TOO_MANY_REQUESTS' } }, { 'Retry-After': '7' }));
    expect(withHeader).toEqual({ kind: 'rate-limited', retryAfter: 7 });

    const missing = await createSyncResetHandoff('csrf', 'token', async () => jsonResponse(429, { error: { code: 'TOO_MANY_REQUESTS' } }));
    expect(missing).toEqual({ kind: 'rate-limited', retryAfter: 60 });

    const nonNumeric = await createSyncResetHandoff('csrf', 'token', async () => jsonResponse(429, { error: { code: 'TOO_MANY_REQUESTS' } }, { 'Retry-After': 'nope' }));
    expect(nonNumeric).toEqual({ kind: 'rate-limited', retryAfter: 60 });
  });

  it('resolves failure on HTTP 500 and network error', async () => {
    const r500 = await createSyncResetHandoff('csrf', 'token', async () => jsonResponse(500, { error: { code: 'INTERNAL' } }));
    expect(r500).toEqual({ kind: 'failure' });

    const rNet = await createSyncResetHandoff('csrf', 'token', async () => {
      throw new Error('network');
    });
    expect(rNet).toEqual({ kind: 'failure' });
  });

  it('POSTs the correct URL with bearer + csrf headers and no body', async () => {
    let url = '';
    let init: RequestInit | undefined;
    await createSyncResetHandoff('the-csrf', 'the-token', async (input, i) => {
      url = input;
      init = i;
      return jsonResponse(200, { openUri: 'vscode://x', expiresTime: '2026-09-09T00:00:00.000Z' });
    });
    const headers = init?.headers as Record<string, string>;
    expect(url).toBe('/api/console/link-flows/create-sync-reset-handoff');
    expect(init?.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer the-token');
    expect(headers['X-CSRF-Token']).toBe('the-csrf');
    expect(headers.Accept).toBe('application/json');
    expect(init?.body).toBeUndefined();
  });
});