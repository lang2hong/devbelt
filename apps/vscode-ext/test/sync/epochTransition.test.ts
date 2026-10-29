import { describe, expect, it, vi } from 'vitest';
import { EpochTransitionCoordinator } from '@devbelt/db-host/sync/epochTransition';
import type { SyncStateSnapshot } from '@devbelt/db-host/sync/e2e/stateStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function snapshot(keyEpoch: string): SyncStateSnapshot {
  return { keyEpoch, stateVersion: '1', changeSequence: '0' };
}

function makeCoordinator(overrides: { setSnapshot?: (s: SyncStateSnapshot) => Promise<void> } = {}) {
  const memento = makeMemento();
  const dekDelete = vi.fn(async () => {});
  const setSnapshot = vi.fn(overrides.setSnapshot ?? (async () => {}));
  const resetRuntime = vi.fn();
  const deps = {
    memento,
    userId: '1',
    dekStore: { store: vi.fn(async () => {}), delete: dekDelete, load: vi.fn(async () => undefined) },
    stateStore: { getSnapshot: () => undefined, setSnapshot, clear: vi.fn(async () => {}) },
    entities: { remove: vi.fn(async () => {}) },
    currentEpoch: () => undefined,
    stopCoordinator: vi.fn(),
    resetRuntime,
  };
  return {
    tx: new EpochTransitionCoordinator(deps as never),
    deps,
    dekDelete,
    setSnapshot,
    resetRuntime,
  };
}

describe('EpochTransitionCoordinator', () => {
  it('reconcile：成功后清旧 epoch DEK、落快照、撤销 intent、重置运行组件', async () => {
    const { tx, dekDelete, resetRuntime } = makeCoordinator();
    await tx.reconcile('1', '2', snapshot('2'));
    expect(dekDelete).toHaveBeenCalledWith('1', 1n);
    expect(tx.pending).toBeUndefined();
    expect(resetRuntime).toHaveBeenCalledTimes(1);
  });

  it('reconcile：先等协调器真正停稳，再写 intent 与清旧 epoch（否则在途轮次会往旧 epoch 复活数据）', async () => {
    const order: string[] = [];
    let finishStop!: () => void;
    const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
    const { tx, deps } = makeCoordinator();
    deps.stopCoordinator.mockImplementation(async () => { order.push('stop-begin'); await stopped; order.push('stop-done'); });
    deps.entities.remove = vi.fn(async () => { order.push('clear'); });
    deps.dekStore.delete.mockImplementation(async () => { order.push('dek-delete'); });

    const running = tx.reconcile('1', '2', snapshot('2'));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['stop-begin']);
    expect(tx.pending).toBeUndefined(); // 还没停稳：连 intent 都不能写

    finishStop();
    await running;
    expect(order[0]).toBe('stop-begin');
    expect(order[1]).toBe('stop-done');
    expect(order.indexOf('dek-delete')).toBeGreaterThan(order.indexOf('stop-done'));
  });

  it('reconcile 失败中途：intent 先落盘，resume(新 epoch) 幂等收敛并返回 true', async () => {
    let fail = true;
    const { tx } = makeCoordinator({
      setSnapshot: async () => {
        if (fail) throw new Error('boom');
      },
    });
    await expect(tx.reconcile('1', '2', snapshot('2'))).rejects.toThrow('boom');
    expect(tx.pending).toEqual({ fromKeyEpoch: '1', toKeyEpoch: '2' });

    fail = false;
    await expect(tx.resume(snapshot('2'))).resolves.toBe(true);
    expect(tx.pending).toBeUndefined();
  });

  it('resume：远端停留 fromKeyEpoch → 撤销 journal 返回 false', async () => {
    const { tx } = makeCoordinator();
    await tx.writePending({ fromKeyEpoch: '1', toKeyEpoch: '2' });
    await expect(tx.resume(snapshot('1'))).resolves.toBe(false);
    expect(tx.pending).toBeUndefined();
  });

  it('resume：远端被推进到 > toKeyEpoch → 清理 from/to 两个 epoch 后撤销 journal', async () => {
    const { tx, dekDelete } = makeCoordinator();
    await tx.writePending({ fromKeyEpoch: '1', toKeyEpoch: '2' });
    await expect(tx.resume(snapshot('3'))).resolves.toBe(false);
    expect(dekDelete).toHaveBeenCalledWith('1', 1n);
    expect(dekDelete).toHaveBeenCalledWith('1', 2n);
    expect(tx.pending).toBeUndefined();
  });

  it('参数 fail-closed：toKeyEpoch 不大于 fromKeyEpoch / 快照 epoch 不匹配时抛错', async () => {
    const { tx } = makeCoordinator();
    await expect(tx.reconcile('2', '2', snapshot('2'))).rejects.toThrow(/greater than/);
    await expect(tx.reconcile('1', '2', snapshot('3'))).rejects.toThrow(/does not match/);
  });
});
describe('EpochTransitionCoordinator.resume 分支 4', () => {
  it('keyEpoch 既不等于 from/to 也不 > to → fail-closed 抛错且保留 intent', async () => {
    const { tx } = makeCoordinator();
    await tx.writePending({ fromKeyEpoch: '1', toKeyEpoch: '3' });
    await expect(tx.resume(snapshot('2'))).rejects.toThrow(/does not match intent/);
    expect(tx.pending).toEqual({ fromKeyEpoch: '1', toKeyEpoch: '3' });
  });
});
