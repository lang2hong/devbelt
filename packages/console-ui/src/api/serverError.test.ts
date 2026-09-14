import { describe, expect, it } from 'vitest';
import { readServerError } from './serverError';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('readServerError', () => {
  it('parses the flat envelope { message, code } (actual server DomainError shape)', async () => {
    const r = await readServerError(jsonRes(400, { message: 'validation failed', code: 'VALIDATION_FAILED' }));
    expect(r).toEqual({ code: 'VALIDATION_FAILED', message: 'validation failed' });
  });

  it('parses the nested envelope { error: { code, message } }', async () => {
    const r = await readServerError(jsonRes(400, { error: { code: 'UNKNOWN_PLAN', message: 'unknown plan' } }));
    expect(r).toEqual({ code: 'UNKNOWN_PLAN', message: 'unknown plan' });
  });

  it('prefers nested message over flat when both present', async () => {
    const r = await readServerError(jsonRes(400, { message: 'flat', code: 'X', error: { code: 'X', message: 'nested' } }));
    expect(r?.message).toBe('nested');
  });

  it('falls back to empty message when neither envelope provides one', async () => {
    const r = await readServerError(jsonRes(400, { code: 'VALIDATION_FAILED' }));
    expect(r).toEqual({ code: 'VALIDATION_FAILED', message: '' });
  });

  it('returns null when no code is present', async () => {
    expect(await readServerError(jsonRes(500, { message: 'oops' }))).toBeNull();
  });

  it('returns null for non-JSON bodies', async () => {
    const res = new Response('not json', { status: 500 });
    expect(await readServerError(res)).toBeNull();
  });
});
