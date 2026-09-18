import { describe, expect, it, vi } from 'vitest';
import { StateStore, type SyncStateSnapshot } from '@devkit/db-host/sync/e2e/stateStore';

function makeMemento(seed?: Record<string, unknown>) {
  const m = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: vi.fn(async (k: string, v: unknown) => { m.set(k, v); }),
  };
}

describe('StateStore', () => {
  it('userId 非正 u64 拒绝', () => {
    expect(() => new StateStore(makeMemento(), '0')).toThrowError(/userId/);
    expect(() => new StateStore(makeMemento(), '01')).toThrowError(/userId/);
  });

  it('set/get roundtrip，键 userId 隔离', async () => {
    const s1 = new StateStore(makeMemento(), '7');
    const s2 = new StateStore(makeMemento(), '8');
    const snap: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '1', changeSequence: '5' };
    await s1.setSnapshot(snap);
    await s2.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '9' });
    expect(s1.getSnapshot()).toEqual(snap);
    expect(s2.getSnapshot()).toEqual({ keyEpoch: '1', stateVersion: '1', changeSequence: '9' });
  });

  it('changeSequence/keyEpoch 回退拒绝', async () => {
    const s = new StateStore(makeMemento(), '7');
    await s.setSnapshot({ keyEpoch: '2', stateVersion: '1', changeSequence: '10' });
    await expect(s.setSnapshot({ keyEpoch: '2', stateVersion: '1', changeSequence: '9' })).rejects.toThrowError(/regress/);
    await expect(s.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '11' })).rejects.toThrowError(/regress/);
  });

  it('同值不抛（单调非严格大于）', async () => {
    const s = new StateStore(makeMemento(), '7');
    await s.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' });
    await expect(s.setSnapshot({ keyEpoch: '1', stateVersion: '2', changeSequence: '5' })).resolves.toBeUndefined();
  });

  it('同 keyEpoch stateVersion 回退拒绝', async () => {
    const s = new StateStore(makeMemento(), '7');
    await s.setSnapshot({ keyEpoch: '1', stateVersion: '5', changeSequence: '5' });
    await expect(s.setSnapshot({ keyEpoch: '1', stateVersion: '4', changeSequence: '6' })).rejects.toThrowError(/stateVersion/);
  });

  it('跨 epoch 允许 stateVersion 重置', async () => {
    const s = new StateStore(makeMemento(), '7');
    await s.setSnapshot({ keyEpoch: '1', stateVersion: '5', changeSequence: '5' });
    await expect(s.setSnapshot({ keyEpoch: '2', stateVersion: '1', changeSequence: '6' })).resolves.toBeUndefined();
    expect(s.getSnapshot()).toEqual({ keyEpoch: '2', stateVersion: '1', changeSequence: '6' });
  });

  it('传播持久化失败', async () => {
    const s = new StateStore({
      get: () => undefined,
      update: async () => { throw new Error('write failed'); },
    }, '7');
    await expect(s.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })).rejects.toThrowError(/write failed/);
  });

  it('clear() 清空快照（回未初始化）', async () => {
    const s = new StateStore(makeMemento(), '7');
    await s.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    expect(s.getSnapshot()).toBeDefined();
    await s.clear();
    expect(s.getSnapshot()).toBeUndefined();
  });
});
