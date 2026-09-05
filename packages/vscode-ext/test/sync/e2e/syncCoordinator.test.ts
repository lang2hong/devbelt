import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../../../src/utils/event';
import { SyncCoordinator } from '../../../src/sync/e2e/syncCoordinator';
import type { SyncEngine } from '../../../src/sync/e2e/syncEngine';
import type { SyncMutator } from '../../../src/sync/e2e/syncMutator';
import type { ConnectionStore } from '../../../src/connection/connectionStore';

describe('SyncCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('source=sync 忽略（回环阻断）；source=user 经 debounce 触发 reconcile+sync（复用同一 engine 实例）', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;

    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const mutator = { reconcile } as unknown as SyncMutator;
    const engine = { sync } as unknown as SyncEngine;

    const coordinator = new SyncCoordinator(store, mutator, engine);
    coordinator.start();

    events.fire('sync');
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcile).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();

    events.fire('user');
    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('reconcile 抛错 → lastError 可观测，后续 user 变更仍能重调度', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;

    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('corrupt outbox'))
      .mockResolvedValueOnce({ generated: 0, pendingSkipped: [], skipped: [] });
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const mutator = { reconcile } as unknown as SyncMutator;
    const engine = { sync } as unknown as SyncEngine;

    const coordinator = new SyncCoordinator(store, mutator, engine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.lastError).toContain('corrupt outbox');
    expect(sync).not.toHaveBeenCalled();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('成功轮次清空上次 lastError', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;

    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('corrupt outbox'))
      .mockResolvedValueOnce({ generated: 0, pendingSkipped: [], skipped: [] });
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const mutator = { reconcile } as unknown as SyncMutator;
    const engine = { sync } as unknown as SyncEngine;

    const coordinator = new SyncCoordinator(store, mutator, engine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.lastError).toContain('corrupt outbox');

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.lastError).toBeUndefined();

    coordinator.stop();
  });

  it('后台轮次得 conflict → lastRun 可观测，lastError 为空', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;

    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'conflict' as const, conflicts: [{ recordId: 'A'.repeat(22), kind: 'version' as const }], applied: 0 }));
    const mutator = { reconcile } as unknown as SyncMutator;
    const engine = { sync } as unknown as SyncEngine;

    const coordinator = new SyncCoordinator(store, mutator, engine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.lastRun?.stage).toBe('conflict');
    expect(coordinator.lastError).toBeUndefined();

    coordinator.stop();
  });

  it('runNow 将本次显式同步失败返回调用方，但不阻断后续重试', async () => {
    const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ generated: 0, pendingSkipped: [], skipped: [] });
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);

    await expect(coordinator.runNow()).rejects.toThrowError('network unavailable');
    await expect(coordinator.runNow()).resolves.toMatchObject({ stage: 'ok' });
    expect(coordinator.lastError).toBeUndefined();
  });
});
