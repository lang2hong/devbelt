import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from '../../src/utils/event';
import { PersonalSyncSession } from '../../src/sync/session';
import { SyncApiError } from '../../src/sync/e2e/client';
import { DekStore } from '../../src/sync/crypto/keyStore';
import { RecordMapStore } from '../../src/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingPutMutation } from '../../src/sync/e2e/pendingMutationStore';
import type { PersonalSyncClient } from '../../src/sync/e2e/client';
import type { ConnectionStore } from '../../src/connection/connectionStore';
import type { CachedEntitlement } from '../../src/sync/authService';
import type { NewStateDto, StateDto } from '../../src/sync/e2e/types';
import { deriveSyncSignKeyPair } from '../../src/sync/crypto/keyStore';
import { encodeBase64Url } from '../../src/sync/crypto/recoveryCode';
import { sealEnvelope } from '../../src/sync/envelope';
import { hkdfSha256, SYNC_INFO } from '../../src/sync/crypto/hkdf';

const kl = vi.hoisted(() => ({
  createInitialMaterial: vi.fn(),
  newRecoveryCode: vi.fn(),
  unlockDek: vi.fn(),
  buildChangeKeyMaterial: vi.fn(),
  buildRecoverMaterial: vi.fn(),
  buildRecoverByAccountMaterial: vi.fn(),
  newStateFromMaterial: vi.fn(),
}));

vi.mock('../../src/sync/keyLifecycle', () => {
  return {
    createInitialMaterial: kl.createInitialMaterial,
    newRecoveryCode: kl.newRecoveryCode,
    unlockDek: kl.unlockDek,
    buildChangeKeyMaterial: kl.buildChangeKeyMaterial,
    buildRecoverMaterial: kl.buildRecoverMaterial,
    buildRecoverByAccountMaterial: kl.buildRecoverByAccountMaterial,
    newStateFromMaterial: kl.newStateFromMaterial,
  };
});

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
    envelopeAccountVersion: '1',
    recoveryCodeSetTime: null,
  };
}

function makeClient(): PersonalSyncClient {
  return {
    getState: async () => validState(),
    getRecords: async () => ({ snapshotSequence: '0', records: [] }),
  } as unknown as PersonalSyncClient;
}

function makeDekStore(opts?: { deleteFailOnce?: boolean; storeFailOnce?: boolean }) {
  let failDelete = opts?.deleteFailOnce ?? false;
  let failStore = opts?.storeFailOnce ?? false;
  const secrets = {
    get: vi.fn(async () => undefined),
    store: vi.fn(async () => { if (failStore) { failStore = false; throw new Error('store failed'); } }),
    delete: vi.fn(async () => { if (failDelete) { failDelete = false; throw new Error('delete failed'); } }),
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

  it('resume 拒绝：snapshot keyEpoch 倒退（< fromKeyEpoch）fail-closed', async () => {
    const memento = makeMemento();
    const { store: dekStore, secrets } = makeDekStore();
    await memento.update('dbclient.sync.epochCleanup.7', { fromKeyEpoch: '2', toKeyEpoch: '3' });

    const s = new PersonalSyncSession('7', memento, dekStore, makeStore().store, makeClient());
    await expect(s.resumeEpochTransition({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' }))
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
        envelopeAccountVersion: '1',
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

const FIX_DEK = new Uint8Array(32).fill(7);

/** 带真实实体 Map + remove spy 的 ConnectionStore（用于验证实体 wipe 行为）。 */
function makeEntityStore(seed: string[] = []) {
  const removedIds: string[] = [];
  const conns = new Map<string, { id: string; deleted?: boolean }>();
  for (const id of seed) conns.set(id, { id });
  const events = new EventEmitter<'user' | 'sync'>();
  const store = {
    onChanged: events.event,
    listForSync: () => [...conns.values()],
    listGroupsForSync: () => [],
    listFoldersForSync: () => [],
    listQueriesForSync: () => [],
    get: (id: string) => conns.get(id),
    getGroupById: () => undefined,
    getFolderById: () => undefined,
    getQueryById: () => undefined,
    save: async () => {},
    remove: vi.fn(async (id: string) => { removedIds.push(id); conns.set(id, { id, deleted: true }); }),
    upsertGroup: async () => {},
    upsertFolder: async () => {},
    upsertQuery: async () => {},
    removeGroup: async () => {},
    removeQueryFolder: async () => {},
    removeQuery: async () => {},
  } as unknown as ConnectionStore;
  return { store, removedIds, conns };
}

function fixedMaterial() {
  return {
    dek: new Uint8Array(32).fill(7),
    signPub: 'B'.repeat(43),
    recoverSignPub: 'C'.repeat(43),
    smpKdf: { alg: 'argon2id' as const, version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'D'.repeat(22), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256' as const, version: 1, salt: 'E'.repeat(22), outputBytes: 32 },
    envelopeSmp: { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '1', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
    envelopeRecovery: { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '1', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
    envelopeAccount: { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '1', nonce: 'I'.repeat(16), ciphertext: 'J'.repeat(43), tag: 'K'.repeat(22) },
    accountRecoveryKey: new Uint8Array(32).fill(8),
  };
}

function changeKeyMaterial() {
  return {
    verifiedDek: new Uint8Array(32).fill(7),
    smpKdf: { alg: 'argon2id' as const, version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'D'.repeat(22), outputBytes: 32 },
    envelopeSmp: { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '2', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
  };
}

function recoverMaterial() {
  return {
    dek: new Uint8Array(32).fill(7),
    oldRecoverSignSeed: new Uint8Array(32).fill(9),
    smpKdf: { alg: 'argon2id' as const, version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'D'.repeat(22), outputBytes: 32 },
    envelopeSmp: { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '2', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
    recoveryKdf: { alg: 'hkdf-sha256' as const, version: 1, salt: 'E'.repeat(22), outputBytes: 32 },
    envelopeRecovery: { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '2', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
    recoverSignPub: 'C'.repeat(43),
  };
}

describe('PersonalSyncSession B5 生命周期', () => {
  beforeEach(() => {
    kl.createInitialMaterial.mockReset();
    kl.newRecoveryCode.mockReset();
    kl.unlockDek.mockReset();
    kl.buildChangeKeyMaterial.mockReset();
    kl.buildRecoverMaterial.mockReset();
    kl.buildRecoverByAccountMaterial.mockReset();
    kl.newStateFromMaterial.mockReset();
    kl.newRecoveryCode.mockReturnValue({ code: 'NEWCODE', raw: new Uint8Array(32).fill(5) });
  });

  it('changeSyncPassword 锁定态抛错（fail-closed），不调用 changeKey', async () => {
    const client = { changeKey: vi.fn(), getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    await expect(s.changeSyncPassword('old', 'new')).rejects.toThrowError(/locked/);
    expect(client.changeKey).not.toHaveBeenCalled();
  });

  it('changeSyncPassword 验证失败（DEK 不匹配）不改 state、不调 changeKey', async () => {
    const changeKey = vi.fn();
    const client = { changeKey, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    kl.buildChangeKeyMaterial.mockResolvedValue({ ...changeKeyMaterial(), verifiedDek: new Uint8Array(32).fill(1) });
    await expect(s.changeSyncPassword('old', 'new')).rejects.toThrowError(/passphrase mismatch/);
    expect(changeKey).not.toHaveBeenCalled();
  });

  it('changeSyncPassword 成功后仅更新 stateVersion（DEK/epoch 不变）', async () => {
    const changeKey = vi.fn(async (_o: { expectedStateVersion: string; seed: Uint8Array }) => ({ keyEpoch: '1', stateVersion: '2' }));
    const client = { changeKey, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    kl.buildChangeKeyMaterial.mockResolvedValue(changeKeyMaterial());

    await s.changeSyncPassword('old', 'new');

    expect(changeKey).toHaveBeenCalledTimes(1);
    expect(changeKey.mock.calls[0][0].expectedStateVersion).toBe('1');
    expect(Buffer.from(changeKey.mock.calls[0][0].seed).toString('hex'))
      .toBe(Buffer.from(deriveSyncSignKeyPair(FIX_DEK).seed).toString('hex'));
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '1', stateVersion: '2', changeSequence: '0' });
    expect(secrets.store).not.toHaveBeenCalled(); // DEK 不变，不写 dekStore
  });

  it('recoverSync 成功后保存 DEK、更新 snapshot、解锁并返回新恢复码', async () => {
    const recover = vi.fn(async () => ({}));
    const recoverDek = new Uint8Array(32).fill(7);
    const state = { ...validState(), signPub: encodeBase64Url(deriveSyncSignKeyPair(recoverDek).publicKey) };
    const getState = vi.fn(async () => state);
    const client = { recover, getState } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    kl.buildRecoverMaterial.mockResolvedValue(recoverMaterial());

    const code = await s.recoverSync('A'.repeat(43), 'new-smp');

    expect(code).toBe('NEWCODE');
    expect(recover).toHaveBeenCalledTimes(1);
    expect(secrets.store).toHaveBeenCalledWith('dbclient.sync.dek.7.1', expect.any(String));
    expect(s.isUnlocked).toBe(true);
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
  });

  it('recoverSync 已解锁态抛错', async () => {
    const client = { recover: vi.fn(), getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    s.unlock('1', FIX_DEK);
    await expect(s.recoverSync('A'.repeat(43), 'new-smp')).rejects.toThrowError(/already unlocked/);
  });

  it('recoverByAccount 成功后保存 DEK、更新 snapshot、解锁并返回新恢复码', async () => {
    const accountRawKey = new Uint8Array(32).fill(3);
    const kekAccount = hkdfSha256(accountRawKey, new Uint8Array(0), SYNC_INFO.kekAccount);
    const envelopeAccount = sealEnvelope(kekAccount, FIX_DEK, '7', '1', 'account', '1');
    const state = { ...validState(), signPub: encodeBase64Url(deriveSyncSignKeyPair(FIX_DEK).publicKey) };
    const recoverViaAccount = vi.fn(async () => ({ accountRecoveryKey: encodeBase64Url(accountRawKey), envelopeAccount }));
    const accountRecover = vi.fn(async () => ({}));
    const getState = vi.fn(async () => state);
    const client = { recoverViaAccount, accountRecover, getState } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    kl.buildRecoverByAccountMaterial.mockResolvedValue({
      smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'D'.repeat(22), outputBytes: 32 },
      envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '2', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
      recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: 'E'.repeat(22), outputBytes: 32 },
      envelopeRecovery: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '2', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
      envelopeAccount: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '2', nonce: 'F'.repeat(16), ciphertext: 'G'.repeat(43), tag: 'H'.repeat(22) },
      accountRecoveryKey: new Uint8Array(32).fill(4),
      recoverSignPub: 'C'.repeat(43),
      signSeed: new Uint8Array(32).fill(5),
    });

    const code = await s.recoverByAccount('login-password', 'new-smp');

    expect(code).toBe('NEWCODE');
    expect(recoverViaAccount).toHaveBeenCalledTimes(1);
    expect(recoverViaAccount).toHaveBeenCalledWith('login-password');
    expect(accountRecover).toHaveBeenCalledTimes(1);
    expect(secrets.store).toHaveBeenCalledWith('dbclient.sync.dek.7.1', expect.any(String));
    expect(s.isUnlocked).toBe(true);
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
  });

  it('recoverByAccount 已解锁态抛错', async () => {
    const client = { recoverViaAccount: vi.fn(), getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    s.unlock('1', FIX_DEK);
    await expect(s.recoverByAccount('login-password', 'new-smp')).rejects.toThrowError(/already unlocked/);
  });

  it('recoverByAccount 恢复出的 DEK 与 state.signPub 不一致 → 拒绝、不写 DEK、不调用 accountRecover', async () => {
    // envelopeAccount 用 FIX_DEK 封装，但 state.signPub 保持默认（不匹配 FIX_DEK 派生的公钥）。
    const accountRawKey = new Uint8Array(32).fill(3);
    const kekAccount = hkdfSha256(accountRawKey, new Uint8Array(0), SYNC_INFO.kekAccount);
    const envelopeAccount = sealEnvelope(kekAccount, FIX_DEK, '7', '1', 'account', '1');
    const recoverViaAccount = vi.fn(async () => ({ accountRecoveryKey: encodeBase64Url(accountRawKey), envelopeAccount }));
    const accountRecover = vi.fn(async () => ({}));
    const getState = vi.fn(async () => validState());
    const client = { recoverViaAccount, accountRecover, getState } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);

    await expect(s.recoverByAccount('login-password', 'new-smp')).rejects.toThrowError(/does not match sync state/);
    expect(accountRecover).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
    expect(s.isUnlocked).toBe(false);
  });

  it('destroySync 成功后走 epoch transition：清理旧 epoch、存新 DEK、解锁新 epoch', async () => {
    const destroy = vi.fn(async () => ({ keyEpoch: '2', stateVersion: '1', changeSequence: '0' }));
    const client = { destroy, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const memento = makeMemento();
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', memento, store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    // 旧 epoch 有些持久化数据，销毁后应被清理
    await new RecordMapStore(memento, '7', '1').put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    kl.unlockDek.mockResolvedValue(new Uint8Array(32).fill(7));
    kl.createInitialMaterial.mockResolvedValue(fixedMaterial());
    kl.newStateFromMaterial.mockReturnValue({} as NewStateDto);

    const code = await s.destroySync('smp');

    expect(code).toBe('NEWCODE');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(new RecordMapStore(memento, '7', '1').getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.1');
    expect(secrets.store).toHaveBeenCalledWith('dbclient.sync.dek.7.2', expect.any(String));
    expect(s.isUnlocked).toBe(true);
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '2', stateVersion: '1', changeSequence: '0' });
  });

  it('destroySync 验证失败（SMP 错误）不调 destroy、不写本地', async () => {
    const destroy = vi.fn();
    const client = { destroy, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    kl.unlockDek.mockResolvedValue(new Uint8Array(32).fill(1));
    await expect(s.destroySync('smp')).rejects.toThrowError(/passphrase mismatch/);
    expect(destroy).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it('resetSyncAfterLoss（无本地 snapshot）成功：存新 DEK、解锁新 epoch', async () => {
    const reset = vi.fn(async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' }));
    const getState = vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); });
    const client = { resetAfterLossWithHandoff: reset, getState } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    kl.createInitialMaterial.mockResolvedValue(fixedMaterial());
    kl.newStateFromMaterial.mockReturnValue({} as NewStateDto);

    const code = await s.resetSyncAfterLoss('token', 'new-smp');

    expect(code).toBe('NEWCODE');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(secrets.store).toHaveBeenCalledWith('dbclient.sync.dek.7.1', expect.any(String));
    expect(s.isUnlocked).toBe(true);
  });

  it('requestResetChallenge 透传 client.resetChallenges', async () => {
    const resetChallenges = vi.fn(async () => {});
    const client = { resetChallenges } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    await s.requestResetChallenge();
    expect(resetChallenges).toHaveBeenCalledTimes(1);
  });

  it('destroy 在新 DEK 落盘中断 → 留 intent，resume 幂等收敛旧 epoch', async () => {
    const destroy = vi.fn(async () => ({ keyEpoch: '2', stateVersion: '1', changeSequence: '0' }));
    const client = { destroy, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const memento = makeMemento();
    const { store, secrets } = makeDekStore({ storeFailOnce: true });
    const s = new PersonalSyncSession('7', memento, store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    await new RecordMapStore(memento, '7', '1').put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    kl.unlockDek.mockResolvedValue(new Uint8Array(32).fill(7));
    kl.createInitialMaterial.mockResolvedValue(fixedMaterial());
    kl.newStateFromMaterial.mockReturnValue({} as NewStateDto);

    await expect(s.destroySync('smp')).rejects.toThrowError(/store failed/);
    // intent 在 store 之前已写（durable），旧 epoch 尚未清理
    expect(s.pendingCleanup).toEqual({ fromKeyEpoch: '1', toKeyEpoch: '2' });
    expect(new RecordMapStore(memento, '7', '1').getByRecordId('A'.repeat(22))).toBeDefined();

    // resume 幂等收敛（无 newDek：由下次 unlockFromState 补 store）
    await s.resumeEpochTransition({ keyEpoch: '2', stateVersion: '1', changeSequence: '0' });
    expect(s.pendingCleanup).toBeUndefined();
    expect(new RecordMapStore(memento, '7', '1').getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.1');
  });

  it('destroy 回执 epoch ≠ 预期 next → fail-closed 不写本地', async () => {
    const destroy = vi.fn(async () => ({ keyEpoch: '9', stateVersion: '1', changeSequence: '0' }));
    const client = { destroy, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    kl.unlockDek.mockResolvedValue(new Uint8Array(32).fill(7));
    kl.createInitialMaterial.mockResolvedValue(fixedMaterial());
    kl.newStateFromMaterial.mockReturnValue({} as NewStateDto);

    await expect(s.destroySync('smp')).rejects.toThrowError(/epoch mismatch/);
    expect(secrets.store).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(s.isUnlocked).toBe(true); // 仍停留在旧 epoch 解锁态
  });

  it('reset 回执 epoch ≠ 预期 next → fail-closed 不写本地', async () => {
    const reset = vi.fn(async () => ({ keyEpoch: '5', stateVersion: '1', changeSequence: '0' }));
    const getState = vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); });
    const client = { resetAfterLossWithHandoff: reset, getState } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    kl.createInitialMaterial.mockResolvedValue(fixedMaterial());
    kl.newStateFromMaterial.mockReturnValue({} as NewStateDto);

    await expect(s.resetSyncAfterLoss('token', 'new-smp')).rejects.toThrowError(/epoch mismatch/);
    expect(secrets.store).not.toHaveBeenCalled();
    expect(s.isUnlocked).toBe(false);
  });

  it('reset 回执 keyEpoch 非 u64 → 拒绝', async () => {
    const reset = vi.fn(async () => ({ keyEpoch: 'abc', stateVersion: '1', changeSequence: '0' }));
    const getState = vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); });
    const client = { resetAfterLossWithHandoff: reset, getState } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    kl.createInitialMaterial.mockResolvedValue(fixedMaterial());
    kl.newStateFromMaterial.mockReturnValue({} as NewStateDto);

    await expect(s.resetSyncAfterLoss('token', 'new-smp')).rejects.toThrowError(/receipt.keyEpoch/);
  });

  it('recover 后 DEK 与 state.signPub 不一致 → 拒绝解锁、不写 DEK', async () => {
    const recover = vi.fn(async () => ({}));
    const getState = vi.fn(async () => validState());
    const client = { recover, getState } as unknown as PersonalSyncClient;
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    kl.buildRecoverMaterial.mockResolvedValue(recoverMaterial());

    await expect(s.recoverSync('A'.repeat(43), 'new-smp')).rejects.toThrowError(/signing key does not match/);
    expect(secrets.store).not.toHaveBeenCalled();
    expect(s.isUnlocked).toBe(false);
  });

  it('changeSyncPassword 回执 epoch 不一致 → 拒绝且不更新 snapshot', async () => {
    const changeKey = vi.fn(async () => ({ keyEpoch: '9', stateVersion: '2' }));
    const client = { changeKey, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const { store } = makeDekStore();
    const s = new PersonalSyncSession('7', makeMemento(), store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    kl.buildChangeKeyMaterial.mockResolvedValue(changeKeyMaterial());

    await expect(s.changeSyncPassword('old', 'new')).rejects.toThrowError(/epoch mismatch/);
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
  });

  it('resetSyncAfterLoss 解锁态抛错（session 边界 fail-closed）', async () => {
    const client = { resetAfterLossWithHandoff: vi.fn(), getState: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }) } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    s.unlock('1', FIX_DEK);
    await expect(s.resetSyncAfterLoss('token', 'new-smp')).rejects.toThrowError(/already unlocked/);
    expect(client.resetAfterLossWithHandoff).not.toHaveBeenCalled();
  });

  it('destroy 回执丢失（请求前已落 intent）→ 重启解锁按 fromKeyEpoch 撤销并继续旧 epoch', async () => {
    const destroy = vi.fn(async () => { throw new Error('network lost'); });
    const client = { destroy, getState: vi.fn(async () => validState()) } as unknown as PersonalSyncClient;
    const memento = makeMemento();
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', memento, store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', FIX_DEK);
    kl.unlockDek.mockResolvedValue(new Uint8Array(32).fill(7));
    kl.createInitialMaterial.mockResolvedValue(fixedMaterial());
    kl.newStateFromMaterial.mockReturnValue({} as NewStateDto);

    await expect(s.destroySync('smp')).rejects.toThrowError(/network lost/);
    // 不可逆请求前 intent 已落盘
    expect(s.pendingCleanup).toEqual({ fromKeyEpoch: '1', toKeyEpoch: '2' });

    // 模拟重启：新会话 unlockFromState，远端仍在旧 epoch '1' → 撤销 journal、正常解锁旧 epoch
    const s2 = new PersonalSyncSession('7', memento, store, makeStore().store, {
      destroy: vi.fn(),
      getState: vi.fn(async () => validState()),
    } as unknown as PersonalSyncClient);
    const dek = new Uint8Array(32).fill(7);
    const state2 = { ...validState('1'), signPub: encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) } as StateDto;
    await s2.unlockFromState(state2, dek);
    expect(s2.pendingCleanup).toBeUndefined();
    expect(memento.get('dbclient.sync.epochCleanup.7')).toBeUndefined();
    expect(s2.isUnlocked).toBe(true);
    expect(secrets.delete).not.toHaveBeenCalled(); // 未提交成功，不清理旧 epoch
  });

  it('resumeEpochTransition：远端停留 fromKeyEpoch → 撤销 journal 返回 false', async () => {
    const memento = makeMemento();
    const { store: dekStore, secrets } = makeDekStore();
    await memento.update('dbclient.sync.epochCleanup.7', { fromKeyEpoch: '1', toKeyEpoch: '2' });
    const s = new PersonalSyncSession('7', memento, dekStore, makeStore().store, makeClient());
    const r = await s.resumeEpochTransition({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    expect(r).toBe(false);
    expect(s.pendingCleanup).toBeUndefined();
    expect(memento.get('dbclient.sync.epochCleanup.7')).toBeUndefined();
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  it('reset 时已有 pendingCleanup → fail-closed：不发 reset 也不替换 intent', async () => {
    const memento = makeMemento();
    await memento.update('dbclient.sync.epochCleanup.7', { fromKeyEpoch: '1', toKeyEpoch: '2' });
    const resetAfterLossWithHandoff = vi.fn(async () => ({ keyEpoch: '3', stateVersion: '1', changeSequence: '0' }));
    const getState = vi.fn(async () => validState('2'));
    const client = { resetAfterLossWithHandoff, getState } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', memento, makeDekStore().store, makeStore().store, client);

    await expect(s.resetSyncAfterLoss('token', 'new-smp')).rejects.toThrowError(/pending sync cleanup/);
    expect(resetAfterLossWithHandoff).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(memento.get('dbclient.sync.epochCleanup.7')).toEqual({ fromKeyEpoch: '1', toKeyEpoch: '2' });
  });

  it('unlockFromState：本地 epoch 落后于远端 → 清理旧 epoch 并解锁新 epoch', async () => {
    const memento = makeMemento();
    const { store, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', memento, store, makeStore().store, makeClient());
    await new RecordMapStore(memento, '7', '1').put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });

    const dek = new Uint8Array(32).fill(7);
    const state2 = { ...validState('2'), signPub: encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) } as StateDto;
    await s.unlockFromState(state2, dek);

    expect(new RecordMapStore(memento, '7', '1').getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.1');
    expect(s.isUnlocked).toBe(true);
    expect(s.getStateStore().getSnapshot()).toEqual({ keyEpoch: '2', stateVersion: '1', changeSequence: '0' });
  });

  it('resumeEpochTransition：远端被推进到 > intent.to → 清理 from 与 to 两个 epoch 的实体与产物并撤销 journal 返回 false', async () => {
    const memento = makeMemento();
    const { store: dekStore, secrets } = makeDekStore();
    const { store, removedIds } = makeEntityStore(['c-1', 'c-2', 'c-new']);
    await memento.update('dbclient.sync.epochCleanup.7', { fromKeyEpoch: '1', toKeyEpoch: '2' });
    // 中断 transition 已把 from(1) 与 to(2) 两个 epoch 的产物都持久化了一部分
    await new RecordMapStore(memento, '7', '1').put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await new RecordMapStore(memento, '7', '2').put('B'.repeat(22), { type: 'connection', localId: 'c-2', recordVersion: '1', revision: 0, status: 'pending' });
    await new PendingMutationStore(memento, '7', '2').put(makePutMutation());
    const s = new PersonalSyncSession('7', memento, dekStore, store, makeClient());

    const r = await s.resumeEpochTransition({ keyEpoch: '3', stateVersion: '1', changeSequence: '0' });
    expect(r).toBe(false);
    expect(s.pendingCleanup).toBeUndefined();
    expect(new RecordMapStore(memento, '7', '1').getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(new RecordMapStore(memento, '7', '2').getByRecordId('B'.repeat(22))).toBeUndefined();
    expect(new PendingMutationStore(memento, '7', '2').list()).toEqual([]);
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.1');
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.2');
    expect(memento.get('dbclient.sync.epochCleanup.7')).toBeUndefined();
    // 两个 epoch 的映射实体（含 pending）都被 wipe，从未映射的 c-new 保留
    expect(removedIds).toEqual(expect.arrayContaining(['c-1', 'c-2']));
    expect(removedIds).not.toContain('c-new');
  });

  it('epochStale：远端 epoch 前进后为 true', async () => {
    vi.useFakeTimers();
    const getState = vi.fn(async () => validState('2'));
    const client = { getState, getRecords: async () => ({ snapshotSequence: '0', records: [] }) } as unknown as PersonalSyncClient;
    const s = new PersonalSyncSession('7', makeMemento(), makeDekStore().store, makeStore().store, client);
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    s.unlock('1', new Uint8Array(32).fill(7));
    s.scheduleNow();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.epochStale).toBe(true);
    vi.useRealTimers();
  });

  it('跨设备迁移清除本地已同步实体，保留未同步实体（Gap-1 Option 1）', async () => {
    const memento = makeMemento();
    const { store, removedIds, conns } = makeEntityStore(['c-synced', 'c-new']);
    const { store: dekStore } = makeDekStore();
    const s = new PersonalSyncSession('7', memento, dekStore, store, makeClient());
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    // 仅 c-synced 有映射；c-new 从未同步（无映射）
    await new RecordMapStore(memento, '7', '1').put('A'.repeat(22), { type: 'connection', localId: 'c-synced', recordVersion: '1', revision: 0, status: 'confirmed' });

    const dek = new Uint8Array(32).fill(7);
    const state2 = { ...validState('2'), signPub: encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) } as StateDto;
    await s.unlockFromState(state2, dek);

    expect(removedIds).toContain('c-synced');
    expect(removedIds).not.toContain('c-new');
    expect(conns.get('c-new')).toEqual({ id: 'c-new' }); // 未同步连接未删除
  });

  it('clearLocalSyncData：purge 已同步实体（snapshot 与 intent 两个 epoch 并集），保留未同步，回未初始化', async () => {
    const memento = makeMemento();
    const { store, removedIds, conns } = makeEntityStore(['c-1', 'c-2', 'c-new']);
    const { store: dekStore, secrets } = makeDekStore();
    const s = new PersonalSyncSession('7', memento, dekStore, store, makeClient());
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    // snapshot 指向 epoch1（c-1 confirmed）；journal {1→2} 让 epoch2 也进清理集合（c-2 confirmed）
    await new RecordMapStore(memento, '7', '1').put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await new RecordMapStore(memento, '7', '2').put('B'.repeat(22), { type: 'connection', localId: 'c-2', recordVersion: '1', revision: 0, status: 'confirmed' });
    await memento.update('dbclient.sync.epochCleanup.7', { fromKeyEpoch: '1', toKeyEpoch: '2' });

    await s.clearLocalSyncData();

    expect(removedIds).toEqual(expect.arrayContaining(['c-1', 'c-2']));
    expect(removedIds).not.toContain('c-new');
    expect(conns.get('c-new')).toEqual({ id: 'c-new' });
    expect(s.getStateStore().getSnapshot()).toBeUndefined();
    expect(new RecordMapStore(memento, '7', '1').getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(new RecordMapStore(memento, '7', '2').getByRecordId('B'.repeat(22))).toBeUndefined();
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.1');
    expect(secrets.delete).toHaveBeenCalledWith('dbclient.sync.dek.7.2');
    expect(memento.get('dbclient.sync.epochCleanup.7')).toBeUndefined();
    expect(s.isUnlocked).toBe(false);
  });

  it('清除 confirmed connection 级联删除其 unmapped query/folder（依赖闭包）', async () => {
    const memento = makeMemento();
    const conns = new Map<string, { id: string; deleted?: boolean }>([['c-1', { id: 'c-1' }]]);
    const folders = new Map<string, { id: string; connId: string; deleted?: boolean }>([['f-1', { id: 'f-1', connId: 'c-1' }]]);
    const queries = new Map<string, { id: string; connId: string; deleted?: boolean }>([['q-1', { id: 'q-1', connId: 'c-1' }]]);
    const events = new EventEmitter<'user' | 'sync'>();
    // 模拟 ConnectionStore.remove 的级联：删连接时级联 tombstone 其 query/folder
    const store = {
      onChanged: events.event,
      listForSync: () => [...conns.values()],
      listGroupsForSync: () => [],
      listFoldersForSync: () => [...folders.values()],
      listQueriesForSync: () => [...queries.values()],
      get: (id: string) => conns.get(id),
      getGroupById: () => undefined,
      getFolderById: (id: string) => folders.get(id),
      getQueryById: (id: string) => queries.get(id),
      save: async () => {},
      remove: vi.fn(async (id: string) => {
        conns.set(id, { id, deleted: true });
        for (const [fid, f] of [...folders]) if (f.connId === id) folders.set(fid, { ...f, deleted: true });
        for (const [qid, q] of [...queries]) if (q.connId === id) queries.set(qid, { ...q, deleted: true });
      }),
      upsertGroup: async () => {},
      upsertFolder: async () => {},
      upsertQuery: async () => {},
      removeGroup: async () => {},
      removeQueryFolder: async () => {},
      removeQuery: async () => {},
    } as unknown as ConnectionStore;

    const { store: dekStore } = makeDekStore();
    const s = new PersonalSyncSession('7', memento, dekStore, store, makeClient());
    await s.getStateStore().setSnapshot({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
    await new RecordMapStore(memento, '7', '1').put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });

    const dek = new Uint8Array(32).fill(7);
    const state2 = { ...validState('2'), signPub: encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey) } as StateDto;
    await s.unlockFromState(state2, dek);

    expect(conns.get('c-1')!.deleted).toBe(true);
    expect(folders.get('f-1')!.deleted).toBe(true); // 依赖闭包：unmapped folder 随 confirmed connection 删除
    expect(queries.get('q-1')!.deleted).toBe(true); // 依赖闭包：unmapped query 随 confirmed connection 删除
  });
});
