import { describe, expect, it } from 'vitest';
import { resolveErrorKind } from './httpError';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('resolveErrorKind', () => {
  it('maps status codes', async () => {
    expect(await resolveErrorKind(jsonRes(401, {}))).toBe('unauthorized');
    expect(await resolveErrorKind(jsonRes(403, {}))).toBe('forbidden');
    expect(await resolveErrorKind(jsonRes(404, {}))).toBe('not-found');
    expect(await resolveErrorKind(jsonRes(500, {}))).toBe('failure');
  });

  it('maps 409 IDEMPOTENCY_IN_PROGRESS to retryable in-progress', async () => {
    expect(await resolveErrorKind(jsonRes(409, { code: 'IDEMPOTENCY_IN_PROGRESS' }))).toBe('in-progress');
    // console envelope shape { error: { code } }
    expect(await resolveErrorKind(jsonRes(409, { error: { code: 'IDEMPOTENCY_IN_PROGRESS' } }))).toBe('in-progress');
  });

  it('maps IDEMPOTENCY_KEY_REUSED and other 409 to terminal conflict', async () => {
    expect(await resolveErrorKind(jsonRes(409, { code: 'IDEMPOTENCY_KEY_REUSED' }))).toBe('conflict');
    expect(await resolveErrorKind(jsonRes(409, { error: { code: 'IDEMPOTENCY_KEY_REUSED' } }))).toBe('conflict');
    expect(await resolveErrorKind(jsonRes(409, { message: 'conflict' }))).toBe('conflict');
  });

  it('maps 400/422 to terminal bad-request (not retryable)', async () => {
    expect(await resolveErrorKind(jsonRes(400, {}))).toBe('bad-request');
    expect(await resolveErrorKind(jsonRes(422, { code: 'VALIDATION_FAILED' }))).toBe('bad-request');
  });

  it('keeps 429 and 5xx as retryable failure', async () => {
    expect(await resolveErrorKind(jsonRes(429, {}))).toBe('failure');
    expect(await resolveErrorKind(jsonRes(502, {}))).toBe('failure');
    expect(await resolveErrorKind(jsonRes(503, {}))).toBe('failure');
  });
});