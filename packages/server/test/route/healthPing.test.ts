import { afterEach, describe, expect, it, vi } from 'vitest';
import { pingDb } from '../../src/route/health.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('pingDb timer hygiene', () => {
  it('clears the timeout timer on success', async () => {
    vi.useFakeTimers();
    await pingDb({ query: async () => 1 } as never, 'SELECT 1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer and rejects on query failure', async () => {
    vi.useFakeTimers();
    await expect(pingDb({ query: async () => { throw new Error('down'); } } as never, 'SELECT 1'))
      .rejects.toThrow('down');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects on timeout and clears the timer', async () => {
    vi.useFakeTimers();
    const pending = pingDb({ query: () => new Promise(() => {}) } as never, 'SELECT 1');
    const assertion = expect(pending).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});