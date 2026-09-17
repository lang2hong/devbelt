import { describe, expect, it } from 'vitest';
import { newIdempotencyKey } from './idempotency';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('newIdempotencyKey', () => {
  it('returns a canonical RFC 4122 UUIDv4', () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
  });

  it('is unique per call', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});