import { describe, expect, it } from 'vitest';
import { useIdempotencyKey, isRetryableFailure } from './idempotentWrite';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('useIdempotencyKey (F2)', () => {
  it('generates a uuidv4 on first submit', () => {
    const w = useIdempotencyKey();
    expect(w.ensure('create:A')).toMatch(UUID_V4);
  });

  it('reuses the same key when retrying the same intent', () => {
    const w = useIdempotencyKey();
    const first = w.ensure('create:A');
    const retry = w.ensure('create:A');
    expect(retry).toBe(first);
  });

  it('generates a new key for a different intent and keeps the prior key', () => {
    const w = useIdempotencyKey();
    const a = w.ensure('role:m1:admin');
    const b = w.ensure('role:m2:admin');
    expect(a).not.toBe(b);
    // going back to the original intent reuses its still-pending key (no overwrite)
    expect(w.ensure('role:m1:admin')).toBe(a);
  });

  it('releases only the reset tag', () => {
    const w = useIdempotencyKey();
    const a = w.ensure('role:m1:admin');
    const b = w.ensure('role:m2:admin');
    w.reset('role:m1:admin');
    expect(w.ensure('role:m1:admin')).not.toBe(a);
    expect(w.ensure('role:m2:admin')).toBe(b);
  });

  it('generates a new key after reset (next business action)', () => {
    const w = useIdempotencyKey();
    const first = w.ensure('create:A');
    w.reset('create:A');
    const second = w.ensure('create:A');
    expect(second).not.toBe(first);
    expect(second).toMatch(UUID_V4);
  });
});

describe('isRetryableFailure', () => {
  it('network/5xx failure and 409 in-progress are retryable', () => {
    expect(isRetryableFailure('failure')).toBe(true);
    expect(isRetryableFailure('in-progress')).toBe(true);
  });

  it('business 4xx are terminal', () => {
    expect(isRetryableFailure('unauthorized')).toBe(false);
    expect(isRetryableFailure('forbidden')).toBe(false);
    expect(isRetryableFailure('not-found')).toBe(false);
    expect(isRetryableFailure('conflict')).toBe(false);
  });
});