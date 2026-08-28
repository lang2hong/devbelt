import { describe, it, expect } from 'vitest';
import { RateLimitService } from '../../src/service/rateLimitService.js';
import { FakeRateLimitRepo } from '../helpers/fakeRepos.js';
import { RateLimitedError } from '../../src/domain/errors.js';

describe('RateLimitService', () => {
  it('hit() allows up to max then throws on exceed', async () => {
    const repo = new FakeRateLimitRepo();
    const svc = new RateLimitService(repo, true);
    for (let i = 0; i < 3; i++) await svc.hit('login:ip:1.2.3.4', 60, 3);
    await expect(svc.hit('login:ip:1.2.3.4', 60, 3)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('assertUnder() is read-only and throws when count >= max', async () => {
    const repo = new FakeRateLimitRepo();
    const svc = new RateLimitService(repo, true);
    await svc.increment('login:email:a@b.c', 60);
    await svc.increment('login:email:a@b.c', 60);
    await expect(svc.assertUnder('login:email:a@b.c', 60, 2)).rejects.toBeInstanceOf(RateLimitedError);
    // 只读：assertUnder 未增加计数，再 increment 一次应为 3（而非 4）
    expect(await svc.increment('login:email:a@b.c', 60)).toBe(3);
  });

  it('distinct buckets are independent', async () => {
    const repo = new FakeRateLimitRepo();
    const svc = new RateLimitService(repo, true);
    await svc.hit('a', 60, 1);
    await expect(svc.hit('b', 60, 1)).resolves.toBeUndefined();
  });

  it('disabled limiter never throws', async () => {
    const repo = new FakeRateLimitRepo();
    const svc = new RateLimitService(repo, false);
    for (let i = 0; i < 100; i++) await svc.hit('x', 1, 1);
    await expect(svc.assertUnder('x', 1, 1)).resolves.toBeUndefined();
  });
});