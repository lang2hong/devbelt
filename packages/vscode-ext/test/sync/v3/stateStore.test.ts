import { describe, expect, it, vi } from 'vitest';
import { StateStore, type SyncStateSnapshot } from '../../../src/sync/v3/stateStore';

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

  it('set/get roundtrip，键 userId 隔离', () => {
    const s1 = new StateStore(makeMemento(), '7');
    const s2 = new StateStore(makeMemento(), '8');
    const snap: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '1', changeSequence: '5' };
    s1.setSnapshot(snap);
    s2.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '9' });
    expect(s1.getSnapshot()).toEqual(snap);
    expect(s2.getSnapshot()).toEqual({ keyEpoch: '1', stateVersion: '1', changeSequence: '9' });
  });

  it('changeSequence/keyEpoch 回退拒绝', () => {
    const s = new StateStore(makeMemento(), '7');
    s.setSnapshot({ keyEpoch: '2', stateVersion: '1', changeSequence: '10' });
    expect(() => s.setSnapshot({ keyEpoch: '2', stateVersion: '1', changeSequence: '9' })).toThrowError(/regress/);
    expect(() => s.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '11' })).toThrowError(/regress/);
  });

  it('同值不抛（单调非严格大于）', () => {
    const s = new StateStore(makeMemento(), '7');
    s.setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' });
    expect(() => s.setSnapshot({ keyEpoch: '1', stateVersion: '2', changeSequence: '5' })).not.toThrow();
  });
});