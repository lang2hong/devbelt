import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../../src/utils/event';
import { PersonalSyncSession } from '../../src/sync/session';
import { DekStore } from '../../src/sync/crypto/keyStore';
import type { PersonalSyncClient } from '../../src/sync/e2e/client';
import type { ConnectionStore } from '../../src/connection/connectionStore';
import type { CachedEntitlement } from '../../src/sync/authService';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function makeStore(): { store: ConnectionStore } {
  const events = new EventEmitter<'user' | 'sync'>();
  return { store: { onChanged: events.event, listForSync: () => [] } as unknown as ConnectionStore };
}

function makeClient(): PersonalSyncClient {
  return {} as PersonalSyncClient;
}

function makeDekStore(opts?: { deleteFailOnce?: boolean }) {
  let fail = opts?.deleteFailOnce ?? false;
  const secrets = {
    get: vi.fn(async () => undefined),
    store: vi.fn(async () => {}),
    delete: vi.fn(async () => { if (fail) { fail = false; throw new Error('delete failed'); } }),
  };
  return { store: new DekStore(secrets as never), secrets };
}

const dek32 = () => new Uint8Array(32);

describe('PersonalSyncSession', () => {
  it('ensureStores epoch 不一致抛错（不静默沿用旧 store）', () => {
    const { store } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, makeClient());
    s.ensureStores('1');
    expect(() => s.ensureStores('2')).toThrowError(/epoch mismatch/);
  });

  it('unlock epoch 不一致抛错（须先走 transition）', () => {
    const { store } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, makeClient());
    s.unlock('1', dek32());
    expect(() => s.unlock('2', dek32())).toThrowError(/epoch mismatch/);
  });

  it('双 unlock 不产生双订阅（start 幂等）', () => {
    const { store } = makeDekStore();
    const spy = vi.fn(() => ({ dispose: () => {} }));
    const fakeStore = { onChanged: spy, listForSync: () => [] } as unknown as ConnectionStore;
    const s = new PersonalSyncSession('7', makeMemento(), store, fakeStore, makeClient());
    s.unlock('1', dek32());
    s.unlock('1', dek32());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('unlock / lock / isUnlocked 生命周期', () => {
    const { store } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, makeClient(), {
      entitlement: () => ({} as CachedEntitlement),
    });
    expect(s.isUnlocked).toBe(false);
    s.unlock('1', dek32());
    expect(s.isUnlocked).toBe(true);
    s.lock();
    expect(s.isUnlocked).toBe(false);
  });

  it('dispose 幂等', () => {
    const { store } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, makeClient());
    s.unlock('1', dek32());
    s.dispose();
    s.dispose();
    expect(s.isUnlocked).toBe(false);
  });

  it('cleanup intent 在删旧 DEK 失败后保留并可续跑至最终一致', async () => {
    const { store, secrets } = makeDekStore({ deleteFailOnce: true });
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, makeClient());
    s.unlock('2', dek32());

    const newSnapshot = { keyEpoch: '3', stateVersion: '1', changeSequence: '5' };
    await expect(s.reconcileEpochTransition('2', '3', newSnapshot)).rejects.toThrowError(/delete failed/);
    expect(s.pendingCleanup).toEqual({ fromKeyEpoch: '2', toKeyEpoch: '3' });

    await s.resumeEpochTransition(newSnapshot);
    expect(s.pendingCleanup).toBeUndefined();
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.2');
    expect(s.isUnlocked).toBe(false);
  });

  it('lock 后在途 pull 调 thunk → 结构化 error（sync session locked）', async () => {
    vi.useFakeTimers();
    let releaseRecords!: (v: unknown) => void;
    const recordsGate = new Promise((r) => { releaseRecords = r; });
    const events = new EventEmitter<'user' | 'sync'>();
    const store = { onChanged: events.event, listForSync: () => [] } as unknown as ConnectionStore;
    const client = {
      getState: async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '1' }),
      getRecords: async () => recordsGate as Promise<unknown>,
    } as unknown as PersonalSyncClient;

    const { store: dekStore } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), dekStore, store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', dek32());

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300); // drain 启动，reconcile 无出站，block 在 getRecords
    s.lock(); // 清 DEK，stop 不等待在途 drain
    releaseRecords({ snapshotSequence: '1', records: [{ recordId: 'A'.repeat(22), version: '1', changeSequence: '1', deleteTime: null, nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22) }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(s.lastRun?.stage).toBe('error');
    expect(s.lastRun?.reason).toContain('sync session locked');
    vi.useRealTimers();
  });
});