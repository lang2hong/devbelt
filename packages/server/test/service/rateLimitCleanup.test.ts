import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startRateLimitCleanup } from '../../src/service/rateLimitCleanup.js';
import { FakeRateLimitRepo } from '../helpers/fakeRepos.js';

describe('rateLimitCleanup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('prunes expired windows and keeps current windows', async () => {
    const repo = new FakeRateLimitRepo();
    const now = Date.now();
    await repo.increment('login:ip:1.2.3.4', new Date(now - 3 * 3600 * 1000)); // 过期（3h 前）
    await repo.increment('login:ip:1.2.3.4', new Date(now)); // 当前窗口

    const started = startRateLimitCleanup(repo, { intervalMs: 1000, retentionMs: 2 * 3600 * 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(repo.store.size).toBe(1);
    started.stop();
  });

  it('is idempotent and keeps running after a no-op', async () => {
    const repo = new FakeRateLimitRepo();
    const now = Date.now();
    await repo.increment('register:ip:1.2.3.4', new Date(now));

    const started = startRateLimitCleanup(repo, { intervalMs: 1000, retentionMs: 2 * 3600 * 1000 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(repo.store.size).toBe(1);
    started.stop();
  });
});