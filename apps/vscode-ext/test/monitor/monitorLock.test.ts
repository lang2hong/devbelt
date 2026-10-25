import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorLock } from '../../src/monitor/monitorLock';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'devbelt-lock-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('MonitorLock', () => {
  it('lets one window hold the lock and renews it', async () => {
    let now = 1_000;
    const a = new MonitorLock({ dir, ownerId: 'a', heartbeatMs: 1_000, now: () => now });
    const b = new MonitorLock({ dir, ownerId: 'b', heartbeatMs: 1_000, now: () => now });
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    now += 2_500;
    expect(await a.tryAcquire()).toBe(true); // renewal
    now += 2_500;
    expect(await b.tryAcquire()).toBe(false); // still fresh (renewed 2.5s ago, stale after 3s)
  });

  it('lets another window take over a stale lock', async () => {
    let now = 1_000;
    const a = new MonitorLock({ dir, ownerId: 'a', heartbeatMs: 1_000, now: () => now });
    const b = new MonitorLock({ dir, ownerId: 'b', heartbeatMs: 1_000, now: () => now });
    await a.tryAcquire();
    now += 3_001;
    expect(await b.tryAcquire()).toBe(true);
    expect(await a.tryAcquire()).toBe(false);
    expect(a.isHeld).toBe(false);
  });

  it('releases only its own lock', async () => {
    const now = 1_000;
    const a = new MonitorLock({ dir, ownerId: 'a', heartbeatMs: 1_000, now: () => now });
    const b = new MonitorLock({ dir, ownerId: 'b', heartbeatMs: 1_000, now: () => now });
    await a.tryAcquire();
    await b.release();
    expect(await b.tryAcquire()).toBe(false);
    await a.release();
    expect(await b.tryAcquire()).toBe(true);
  });
});
