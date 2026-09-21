import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '@devbelt/db-host/utils/event';
import { SyncCoordinator } from '@devbelt/db-host/sync/e2e/syncCoordinator';
import type { SyncEngine } from '@devbelt/db-host/sync/e2e/syncEngine';
import type { SyncMutator } from '@devbelt/db-host/sync/e2e/syncMutator';
import type { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';

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

  it('scheduleNow 跳过 debounce 立即同步', async () => {
    vi.useFakeTimers();
    const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);
    coordinator.start();

    coordinator.scheduleNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('stage=error 触发指数退避重试（1s→2s），成功复位', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn()
      .mockResolvedValueOnce({ stage: 'error' as const, conflicts: [], applied: 0, reason: 'network' })
      .mockResolvedValueOnce({ stage: 'error' as const, conflicts: [], applied: 0, reason: 'network' })
      .mockResolvedValue({ stage: 'ok' as const, conflicts: [], applied: 0 });
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300); // debounce → drain → error
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // 首次退避
    expect(sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000); // 第二次退避翻倍为 2s，未到
    expect(sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000); // 到 2s，触发并成功
    expect(sync).toHaveBeenCalledTimes(3);
    expect(coordinator.stalled).toBe(false);

    coordinator.stop();
  });

  it('conflict 停止自动重试并标记 stalled，不再请求', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'conflict' as const, conflicts: [{ recordId: 'A'.repeat(22), kind: 'version' as const }], applied: 0 }));
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.stalled).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30000);
    expect(sync).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('paging-stalled（result.stalled）即使 stage=error 也停止重试', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'error' as const, conflicts: [], applied: 0, stalled: { mutationId: 'A'.repeat(22) }, reason: 'paging stalled' }));
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.stalled).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30000);
    expect(sync).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('onSettled 在每轮结束后收到结果（含 applied）', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 2 }));
    const onSettled = vi.fn();
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine, { onSettled });
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ applied: 2 }));

    coordinator.stop();
  });

  it('onSettled 抛错不阻断同步链', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const onSettled = vi.fn(() => { throw new Error('boom'); });
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine, { onSettled });
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(coordinator.lastError).toBeUndefined();

    coordinator.stop();
  });

  it('retrying 在退避等待期为 true，成功后复位', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn()
      .mockResolvedValueOnce({ stage: 'error' as const, conflicts: [], applied: 0, reason: 'network' })
      .mockResolvedValue({ stage: 'ok' as const, conflicts: [], applied: 0 });
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.retrying).toBe(true);

    await vi.advanceTimersByTimeAsync(1000); // 退避触发并成功
    expect(coordinator.retrying).toBe(false);
    expect(coordinator.stalled).toBe(false);

    coordinator.stop();
  });

  it('stop→start 重入时清除 stalled 状态', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'conflict' as const, conflicts: [{ recordId: 'A'.repeat(22), kind: 'version' as const }], applied: 0 }));
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(coordinator.stalled).toBe(true);

    coordinator.stop();
    coordinator.start();
    expect(coordinator.stalled).toBe(false);

    coordinator.stop();
  });

  it('autoSyncEnabled=false：onChanged 不自动触发，scheduleNow 仍可用', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const coordinator = new SyncCoordinator(
      store,
      { reconcile } as unknown as SyncMutator,
      { sync } as unknown as SyncEngine,
      { autoSyncEnabled: () => false },
    );
    coordinator.start();

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(sync).not.toHaveBeenCalled();

    // 显式命令不受开关影响
    coordinator.scheduleNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('autoSyncEnabled 由 false 变 true 后 onChanged 恢复自动触发', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    let auto = false;
    const coordinator = new SyncCoordinator(
      store,
      { reconcile } as unknown as SyncMutator,
      { sync } as unknown as SyncEngine,
      { autoSyncEnabled: () => auto },
    );
    coordinator.start();

    // 关闭期间 onChanged 不触发
    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(sync).not.toHaveBeenCalled();

    auto = true;
    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(sync).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });
});
