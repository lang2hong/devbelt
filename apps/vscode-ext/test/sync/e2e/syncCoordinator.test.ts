import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '@devbelt/db-host/utils/event';
import { SyncCoordinator } from '@devbelt/db-host/sync/e2e/syncCoordinator';
import { SYNC_CANCELLED_REASON } from '@devbelt/db-host/sync/e2e/syncEngine';
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

  it('runNow：reconcile 有出站跳过时结果带 skippedOutbound（透明度）', async () => {
    const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 1, pendingSkipped: [], skipped: [{ ref: 'connection:c-1', reason: 'unknown DatabaseType' }] }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);

    await expect(coordinator.runNow()).resolves.toMatchObject({
      stage: 'ok',
      skippedOutbound: 1,
      skippedOutboundReason: 'unknown DatabaseType',
    });
  });

  it('findingsNow/repairFindingsNow：经串行链执行并返回引擎结果（S7k）', async () => {
    const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
    const inspectFindings = vi.fn(async () => ({ findings: [{ id: 'missing:connection:c-1', kind: 'missing', type: 'connection', localId: 'c-1' }], incomplete: false }));
    const repairFindings = vi.fn(async () => ({ cloud: 1, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0 }));
    const coordinator = new SyncCoordinator(
      store,
      { reconcile: vi.fn() } as unknown as SyncMutator,
      { inspectFindings, repairFindings } as unknown as SyncEngine,
    );

    await expect(coordinator.findingsNow()).resolves.toMatchObject({ findings: [{ kind: 'missing', localId: 'c-1' }] });
    await expect(coordinator.repairFindingsNow()).resolves.toMatchObject({ cloud: 1 });
    expect(repairFindings).toHaveBeenCalledTimes(1);
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

  it('显式 push 失败不排后台重试（不隐式触发 both/pull）', async () => {
    vi.useFakeTimers();
    const store = { onChanged: () => ({ dispose() { /* noop */ } }) } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const syncPhase = vi.fn(async () => ({ stage: 'error' as const, conflicts: [], applied: 0, reason: 'boom' }));
    const sync = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 0 }));
    const coordinator = new SyncCoordinator(
      store,
      { reconcile } as unknown as SyncMutator,
      { syncPhase, sync } as unknown as SyncEngine,
    );

    await coordinator.pushNow();
    await vi.advanceTimersByTimeAsync(10_000); // 旧行为：armRetry → enqueue → drain → engine.sync()

    expect(syncPhase).toHaveBeenCalledTimes(1);
    expect(sync).not.toHaveBeenCalled();
  });

  it('drain 跨轮累加 pushed/changes（第 2 轮不覆盖第 1 轮）', async () => {
    const store = { onChanged: () => ({ dispose() { /* noop */ } }) } as unknown as ConnectionStore;
    const reconcile = vi.fn()
      .mockResolvedValueOnce({ generated: 1, pendingSkipped: [], skipped: [] })
      .mockResolvedValueOnce({ generated: 0, pendingSkipped: [], skipped: [] });
    const sync = vi.fn()
      .mockResolvedValueOnce({ stage: 'ok' as const, conflicts: [], applied: 0, pushed: 2, changes: 0 })
      .mockResolvedValueOnce({ stage: 'ok' as const, conflicts: [], applied: 0, pushed: 0, changes: 1 });
    const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync } as unknown as SyncEngine);
    const r = await coordinator.runNow();
    expect(r?.pushed).toBe(2);
    expect(r?.changes).toBe(1);
  });

  it('显式 pull/push 触发 onSyncStart（状态栏"进行中"）', async () => {
    const store = { onChanged: () => ({ dispose() { /* noop */ } }) } as unknown as ConnectionStore;
    const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
    const syncPhase = vi.fn(async () => ({ stage: 'ok' as const, conflicts: [], applied: 1 }));
    const starts: string[] = [];
    const coordinator = new SyncCoordinator(
      store,
      { reconcile } as unknown as SyncMutator,
      { syncPhase } as unknown as SyncEngine,
      { onSyncStart: (p) => starts.push(p) },
    );
    await coordinator.pullNow();
    await coordinator.pushNow();
    expect(starts).toEqual(['pull', 'push']);
  });

  describe('stopAndDrain / 取消', () => {
    it('等在途轮次真正结束后才返回，并先取消引擎', async () => {
      const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const events: string[] = [];
      const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
      const sync = vi.fn(async () => { await gate; events.push('sync-finished'); return { stage: 'ok' as const, conflicts: [], applied: 0 }; });
      const cancel = vi.fn(() => { events.push('cancel'); });
      const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync, cancel, resume: vi.fn() } as unknown as SyncEngine);
      coordinator.start();
      coordinator.scheduleNow();
      await vi.waitFor(() => expect(sync).toHaveBeenCalled());

      const drained = coordinator.stopAndDrain().then(() => events.push('drained'));
      await Promise.resolve();
      expect(events).toEqual(['cancel']);
      release();
      await drained;
      expect(events).toEqual(['cancel', 'sync-finished', 'drained']);
    });

    it('网络卡死时按超时放弃等待，不拖死 destroy/reset', async () => {
      vi.useFakeTimers();
      const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
      const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
      const sync = vi.fn(() => new Promise<never>(() => {}));
      const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync, cancel: vi.fn(), resume: vi.fn() } as unknown as SyncEngine);
      coordinator.start();
      coordinator.scheduleNow();
      await vi.advanceTimersByTimeAsync(0);

      let done = false;
      void coordinator.stopAndDrain(5_000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(done).toBe(true);
    });

    it('被取消的轮次不记为失败：不排退避重试，不覆盖 lastRun', async () => {
      vi.useFakeTimers();
      const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
      const reconcile = vi.fn(async () => ({ generated: 0, pendingSkipped: [], skipped: [] }));
      const sync = vi.fn()
        .mockResolvedValueOnce({ stage: 'ok' as const, conflicts: [], applied: 1 })
        .mockResolvedValue({ stage: 'error' as const, conflicts: [], applied: 0, reason: SYNC_CANCELLED_REASON });
      const coordinator = new SyncCoordinator(store, { reconcile } as unknown as SyncMutator, { sync, cancel: vi.fn(), resume: vi.fn() } as unknown as SyncEngine);
      coordinator.start();

      coordinator.scheduleNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.lastRun?.stage).toBe('ok');

      coordinator.scheduleNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.lastRun?.stage).toBe('ok');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(coordinator.stalled).toBe(false);

      coordinator.stop();
    });

    it('start() 放开引擎的取消标志（lock → unlock 复用同一引擎）', () => {
      const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
      const resume = vi.fn();
      const coordinator = new SyncCoordinator(store, {} as unknown as SyncMutator, { resume } as unknown as SyncEngine);
      coordinator.start();
      expect(resume).toHaveBeenCalledTimes(1);
    });

    it('引擎没有 cancel/resume（旧替身）时不抛', async () => {
      const store = { onChanged: () => ({ dispose: () => {} }) } as unknown as ConnectionStore;
      const coordinator = new SyncCoordinator(store, {} as unknown as SyncMutator, {} as unknown as SyncEngine);
      coordinator.start();
      await expect(coordinator.stopAndDrain(10)).resolves.toBeUndefined();
    });
  });
});
