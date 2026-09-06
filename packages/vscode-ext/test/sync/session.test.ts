import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../../src/utils/event';
import { PersonalSyncSession } from '../../src/sync/session';
import { DekStore } from '../../src/sync/crypto/keyStore';
import { RecordMapStore } from '../../src/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingPutMutation } from '../../src/sync/e2e/pendingMutationStore';
import type { PersonalSyncClient } from '../../src/sync/e2e/client';
import type { ConnectionStore } from '../../src/connection/connectionStore';
import type { CachedEntitlement } from '../../src/sync/authService';
import type { NewStateDto, StateDto } from '../../src/sync/e2e/types';
import { deriveSyncSignKeyPair } from '../../src/sync/crypto/keyStore';
import { encodeBase64Url } from '../../src/sync/crypto/recoveryCode';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function makeStore(): { store: ConnectionStore } {
  const events = new EventEmitter<'user' | 'sync'>();
  return { store: {
    onChanged: events.event,
    listForSync: () => [],
    listGroupsForSync: () => [],
    listFoldersForSync: () => [],
    listQueriesForSync: () => [],
    get: () => undefined,
    getGroupById: () => undefined,
    getFolderById: () => undefined,
    getQueryById: () => undefined,
    save: async () => {},
    remove: async () => {},
    upsertGroup: async () => {},
    upsertFolder: async () => {},
    upsertQuery: async () => {},
    removeGroup: async () => {},
    removeQueryFolder: async () => {},
    removeQuery: async () => {},
  } as unknown as ConnectionStore };
}

function validState(keyEpoch = '1', stateVersion = '1', changeSequence = '0'): StateDto {
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    keyEpoch, stateVersion, changeSequence,
    signPub: 'A'.repeat(43), recoverSignPub: 'A'.repeat(43),
    smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'A'.repeat(22), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: 'A'.repeat(22), outputBytes: 32 },
    envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(43), tag: 'A'.repeat(22) },
    envelopeRecovery: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(43), tag: 'A'.repeat(22) },
    recoveryCodeSetTime: null,
  };
}

function makeClient(): PersonalSyncClient {
  return {
    getState: async () => validState(),
    getRecords: async () => ({ snapshotSequence: '0', records: [] }),
  } as unknown as PersonalSyncClient;
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

function makePutMutation(): PendingPutMutation {
  return {
    action: 'record.put', recordId: 'A'.repeat(22), type: 'connection', localId: 'c-1', baseVersion: '0',
    mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
    signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), revision: 0, consecutiveFailureCount: 0,
  };
}

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
    const realStore = makeStore().store;
    const spy = vi.spyOn(realStore, 'onChanged');
    const s = new PersonalSyncSession('7', makeMemento(), store, realStore, makeClient());
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

  it('initializeSync 远端 init 成功后才持久化 DEK/snapshot 并解锁', async () => {
    const { store, secrets } = makeDekStore();
    const init = vi.fn(async () => {});
    const client = {
      init, getState: async () => validState(), getRecords: async () => ({ snapshotSequence: '0', records: [] }),
    } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);

    await s.initializeSync({} as NewStateDto, dek32());

    expect(init).toHaveBeenCalledTimes(1);
    expect(secrets.store).toHaveBeenCalledWith('dbclient.sync.dek.7.1', expect.any(String));
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    expect(s.isUnlocked).toBe(true);
  });

  it('getRemoteState 严格校验网络响应，unlockFromState 持久化确认快照后解锁', async () => {
    const { store, secrets } = makeDekStore();
    const getState = vi.fn()
      .mockResolvedValueOnce({ keyEpoch: '1' })
      .mockResolvedValue(validState());
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, {
      getState, getRecords: async () => ({ snapshotSequence: '0', records: [] }),
    } as unknown as PersonalSyncClient);
    await expect(s.getRemoteState()).rejects.toThrowError(/unexpected key|protocol/);

    const dek = dek32();
    await s.unlockFromState({ keyEpoch: '2', stateVersion: '3', changeSequence: '4', signPub: encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) } as StateDto, dek);
    expect(secrets.store).toHaveBeenCalledWith('dbclient.sync.dek.7.2', expect.any(String));
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '2', stateVersion: '3', changeSequence: '4' });
    expect(s.isUnlocked).toBe(true);
  });

  it('unlockFromState 拒绝与 state.signPub 不一致的 DEK，且不落盘或解锁', async () => {
    const memento = makeMemento();
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', memento, store, makeStore().store, makeClient());

    await expect(s.unlockFromState({ keyEpoch: '1', stateVersion: '1', changeSequence: '0', signPub: 'A'.repeat(43) } as StateDto, dek32()))
      .rejects.toThrowError(/signing key does not match/);
    expect(secrets.store).not.toHaveBeenCalled();
    expect(s.getStateStore().getSnapshot()).toBeUndefined();
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

  it('epoch transition 拒绝：snapshot keyEpoch 与 toKeyEpoch 不匹配', async () => {
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, makeClient());
    s.unlock('2', dek32());

    await expect(s.reconcileEpochTransition('2', '3', { keyEpoch: '2', stateVersion: '1', changeSequence: '5' }))
      .rejects.toThrowError(/snapshot keyEpoch does not match/);
    expect(s.pendingCleanup).toBeUndefined();
    expect(s.getStateStore().getSnapshot()).toBeUndefined();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(s.isUnlocked).toBe(true);
  });

  it('epoch transition 拒绝：目标 epoch 不前进（相同 / 倒退）', async () => {
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, makeClient());
    s.unlock('3', dek32());

    for (const target of ['3', '2']) {
      await expect(s.reconcileEpochTransition('3', target, { keyEpoch: target, stateVersion: '1', changeSequence: '5' }))
        .rejects.toThrowError(/toKeyEpoch must be greater/);
    }
    expect(s.pendingCleanup).toBeUndefined();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(s.isUnlocked).toBe(true);
  });

  it('lock 后在途 pull 调 thunk → 结构化 error（sync session locked）', async () => {
    vi.useFakeTimers();
    let releaseRecords!: (v: unknown) => void;
    const recordsGate = new Promise((r) => { releaseRecords = r; });
    const store = makeStore().store;
    const client = {
      getState: async () => validState('1', '1', '1'), // 远端 changeSequence '1' > local '0'，触发 pull
      getRecords: async () => recordsGate as Promise<unknown>,
    } as unknown as PersonalSyncClient;

    const { store: dekStore } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), dekStore, store, client);
    const dek = dek32();
    // unlockFromState 解锁即 scheduleInitialSync → 首次 drain 阻塞在 getRecords（在途）
    await s.unlockFromState({ keyEpoch: '1', stateVersion: '1', changeSequence: '0', signPub: encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) } as StateDto, dek);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0); // 确保首次 drain 已进入在途 getRecords
    s.lock(); // 清 DEK，stop 不等待在途 drain
    releaseRecords({ snapshotSequence: '1', records: [{ recordId: 'A'.repeat(22), version: '1', changeSequence: '1', deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1, nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22) }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(s.lastRun?.stage).toBe('error');
    expect(s.lastRun?.reason).toContain('sync session locked');
    vi.useRealTimers();
  });

  it('重启后 resume（内存 store 未建）仍清空旧 epoch 持久化键 + 删 DEK + 清 intent', async () => {
    const memento = makeMemento();
    const { store: dekStore, secrets } = makeDekStore();

    // 旧 epoch=2 的持久化 store 留数据 + cleanup intent（模拟上一次切换崩在清 store 前）
    await new RecordMapStore(memento, '7', '2').put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await new PendingMutationStore(memento, '7', '2').put(makePutMutation());
    await memento.update('dbclient.sync.epochCleanup.7', { fromKeyEpoch: '2', toKeyEpoch: '3' });

    // 新会话（未 unlock，内存 mapStore/outbox 均为 undefined）= 扩展重启
    const s = new PersonalSyncSession('7', memento, dekStore, makeStore().store, makeClient());
    await expect(s.resumeEpochTransition({ keyEpoch: '3', stateVersion: '1', changeSequence: '5' })).resolves.toBe(true);

    expect(new RecordMapStore(memento, '7', '2').getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(new PendingMutationStore(memento, '7', '2').list()).toEqual([]);
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.2');
    expect(memento.get('dbclient.sync.epochCleanup.7')).toBeUndefined();
  });

  it('resume 拒绝：snapshot keyEpoch 与 intent toKeyEpoch 不匹配', async () => {
    const memento = makeMemento();
    const { store: dekStore, secrets } = makeDekStore();
    await memento.update('dbclient.sync.epochCleanup.7', { fromKeyEpoch: '2', toKeyEpoch: '3' });

    const s = new PersonalSyncSession('7', memento, dekStore, makeStore().store, makeClient());
    await expect(s.resumeEpochTransition({ keyEpoch: '5', stateVersion: '1', changeSequence: '5' }))
      .rejects.toThrowError(/resume snapshot keyEpoch does not match/);
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(memento.get('dbclient.sync.epochCleanup.7')).toEqual({ fromKeyEpoch: '2', toKeyEpoch: '3' });
  });

  it('scheduleNow / scheduleInitialSync 未解锁抛错（fail-closed）', () => {
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, makeClient());
    expect(() => s.scheduleNow()).toThrowError(/locked/);
    expect(() => s.scheduleInitialSync()).toThrowError(/locked/);
    expect(s.stalled).toBe(false);
  });

  it('onSyncResult 透传：后台 drain 结束后回调', async () => {
    vi.useFakeTimers();
    const events = new EventEmitter<'user' | 'sync'>();
    const store = {
      onChanged: events.event, listForSync: () => [], listGroupsForSync: () => [],
      listFoldersForSync: () => [], listQueriesForSync: () => [], getGroupById: () => undefined,
      getFolderById: () => undefined, getQueryById: () => undefined,
    } as unknown as ConnectionStore;
    const client = {
      getState: async () => ({
        protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
        keyEpoch: '1', stateVersion: '1', changeSequence: '0',
        signPub: 'A'.repeat(43), recoverSignPub: 'A'.repeat(43),
        smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'A'.repeat(22), outputBytes: 32 },
        recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: 'A'.repeat(22), outputBytes: 32 },
        envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(43), tag: 'A'.repeat(22) },
        envelopeRecovery: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(43), tag: 'A'.repeat(22) },
        recoveryCodeSetTime: null,
      }),
      getRecords: async () => ({ snapshotSequence: '0', records: [] }),
    } as unknown as PersonalSyncClient;

    const onSyncResult = vi.fn();
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, store, client, { onSyncResult });
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', dek32());

    events.fire('user');
    await vi.advanceTimersByTimeAsync(300);
    expect(onSyncResult).toHaveBeenCalled();
    expect(s.lastRun).toBeDefined();
    vi.useRealTimers();
  });

  it('initializeSync 不触发首次同步（恢复码确认前零请求）', async () => {
    vi.useFakeTimers();
    const getState = vi.fn(async () => validState());
    const client = {
      init: vi.fn(async () => {}),
      getState,
      getRecords: async () => ({ snapshotSequence: '0', records: [] }),
    } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    await s.initializeSync({} as NewStateDto, dek32());

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(getState).not.toHaveBeenCalled(); // 初始化路径不自动同步，等命令层确认恢复码后 syncNow
    vi.useRealTimers();
  });

  it('unlockFromState 触发首次同步恰好一次', async () => {
    vi.useFakeTimers();
    const getState = vi.fn(async () => validState());
    const client = { getState, getRecords: async () => ({ snapshotSequence: '0', records: [] }) } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    const dek = dek32();
    await s.unlockFromState({ keyEpoch: '1', stateVersion: '1', changeSequence: '0', signPub: encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) } as StateDto, dek);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(getState).toHaveBeenCalledTimes(1); // 解锁即首次同步，且仅一次
    vi.useRealTimers();
  });
});
