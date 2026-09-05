import { describe, expect, it, vi } from 'vitest';
import { SyncEngine } from '../../../src/sync/e2e/syncEngine';
import { SyncApiError, type PersonalSyncClient } from '../../../src/sync/e2e/client';
import { RecordMapStore } from '../../../src/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingDeleteMutation, type PendingPutMutation } from '../../../src/sync/e2e/pendingMutationStore';
import type { SyncStateSnapshot } from '../../../src/sync/e2e/stateStore';
import { EntityStore, UnresolvedRefStore } from '../../../src/sync/e2e/entityStore';
import type { SavedConnection, ConnectionStore } from '../../../src/connection/connectionStore';
import type { StateDto } from '../../../src/sync/e2e/types';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function makeStateStore(snap?: SyncStateSnapshot, setImpl?: (s: SyncStateSnapshot) => Promise<void>) {
  return {
    getSnapshot: vi.fn(() => snap),
    setSnapshot: vi.fn(setImpl ?? (async (_s: SyncStateSnapshot) => {})),
  };
}

function makeStore(seed: SavedConnection[] = []) {
  const conns = new Map<string, SavedConnection>(seed.map((c) => [c.id, c]));
  const cs = {
    get: (id: string) => conns.get(id),
    save: vi.fn(async (c: SavedConnection) => { conns.set(c.id, { ...c, updateTime: Date.now() }); }),
    remove: vi.fn(async (id: string) => { const c = conns.get(id); if (c) conns.set(id, { ...c, deleted: true, updateTime: Date.now() }); }),
    listForSync: () => [...conns.values()],
    listGroupsForSync: () => [] as never[],
    listFoldersForSync: () => [] as never[],
    listQueriesForSync: () => [] as never[],
    getGroupById: () => undefined,
    getFolderById: () => undefined,
    getQueryById: () => undefined,
    upsertGroup: async () => {},
    upsertFolder: async () => {},
    upsertQuery: async () => {},
    removeGroup: async () => {},
    removeQueryFolder: async () => {},
    removeQuery: async () => {},
    all: () => [...conns.values()].filter((c) => !(c as unknown as { deleted?: boolean }).deleted),
  } as unknown as ConnectionStore;
  return cs;
}

const b64 = (bytes: number) => 'A'.repeat(Math.ceil((bytes * 4) / 3));

function envelope() {
  return {
    protocolVersion: 1 as const,
    cipherSuite: 'AES-256-GCM' as const,
    formatVersion: 1 as const,
    envelopeVersion: '1',
    nonce: b64(12),
    ciphertext: b64(32),
    tag: b64(16),
  };
}

/** 返回一个可通过 validateSyncState 的完整 state 响应（默认 epoch1/v1/seq0）。 */
function stateDto(over: Partial<StateDto> = {}): StateDto {
  return {
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    keyEpoch: '1',
    stateVersion: '1',
    changeSequence: '0',
    signPub: b64(32),
    recoverSignPub: b64(32),
    smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: b64(16), outputBytes: 32 },
    recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: b64(16), outputBytes: 32 },
    envelopeSmp: envelope(),
    envelopeRecovery: envelope(),
    recoveryCodeSetTime: null,
    ...over,
  };
}

function clientWith(over: Partial<PersonalSyncClient> = {}) {
  return {
    getState: vi.fn(async () => stateDto()),
    getRecords: vi.fn(async () => ({ snapshotSequence: '0', records: [] })),
    putRecord: vi.fn(async () => ({ version: '1', changeSequence: '1' })),
    deleteRecord: vi.fn(async () => ({ version: '1', changeSequence: '1' })),
    putRecordSigned: vi.fn(async () => ({ version: '1', changeSequence: '1' })),
    deleteRecordSigned: vi.fn(async () => ({ version: '1', changeSequence: '1' })),
    ...over,
  } as unknown as PersonalSyncClient;
}

interface EngineOpts {
  client: PersonalSyncClient;
  snap?: SyncStateSnapshot;
  mapStore: RecordMapStore;
  outbox: PendingMutationStore;
  store?: ReturnType<typeof makeStore>;
  setImpl?: (s: SyncStateSnapshot) => Promise<void>;
  signSeed?: () => Uint8Array;
}

function engine(opts: EngineOpts) {
  const store = opts.store ?? makeStore();
  const memento = makeMemento();
  return new SyncEngine({
    userId: '7',
    keyEpoch: '1',
    client: opts.client,
    stateStore: makeStateStore(opts.snap, opts.setImpl) as never,
    mapStore: opts.mapStore,
    outbox: opts.outbox,
    entities: new EntityStore(store),
    unresolved: new UnresolvedRefStore(memento, '7', '1'),
    dek: () => new Uint8Array(32),
    signSeed: opts.signSeed ?? (() => new Uint8Array(32)),
    uniqueId: () => `c-new-${Math.random()}`,
  });
}

const SNAP: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '1', changeSequence: '0' };

function putMutation(): PendingPutMutation {
  return {
    action: 'record.put', recordId: 'A'.repeat(22), type: 'connection', localId: 'c-1', baseVersion: '0',
    mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
    signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), revision: 0, consecutiveFailureCount: 0,
  };
}

describe('SyncEngine', () => {
  it('并发 sync() 单飞合并', async () => {
    const client = clientWith();
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const [a, b] = await Promise.all([eng.sync(), eng.sync()]);
    expect(client.getState).toHaveBeenCalledTimes(1);
    expect(a.stage).toBe('ok');
    expect(b.stage).toBe('ok');
  });

  it('远端 epoch 高于本地 → epoch-mismatch，不拉 feed', async () => {
    const client = clientWith({ getState: vi.fn(async () => stateDto({ keyEpoch: '2', stateVersion: '1', changeSequence: '1' })) });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const r = await eng.sync();
    expect(r.stage).toBe('epoch-mismatch');
    expect(client.getRecords).not.toHaveBeenCalled();
  });

  it('outbox 重放逐字复用 persistent signature（signSeed 抛错仍成功）', async () => {
    const client = clientWith();
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const m = putMutation();
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox, signSeed: () => { throw new Error('should not sign'); } });
    const r = await eng.sync();
    expect(r.stage).toBe('ok');
    expect(client.putRecordSigned).toHaveBeenCalledWith({
      keyEpoch: '1', mutationId: m.mutationId, recordId: m.recordId, baseVersion: m.baseVersion,
      signature: m.signature, requestDigest: m.requestDigest, nonce: m.nonce, ciphertext: m.ciphertext, tag: m.tag,
    });
    expect(client.putRecord).not.toHaveBeenCalled();
    expect(outbox.list()).toHaveLength(0);
  });

  it('outbox 重放 409(terminal 码) → terminal，保留 outbox 项', async () => {
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'CONFLICT'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const m = putMutation();
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.terminal).toEqual({ mutationId: m.mutationId, code: 'CONFLICT' });
    expect(outbox.list()).toHaveLength(1);
  });

  it('outbox 重放 5xx → error，保留 outbox 待重演', async () => {
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(503, undefined); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(outbox.list()).toHaveLength(1);
  });

  it('pull 记录 conflict 停止：cursor 不前移', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'pending' });
    const store = makeStore([{ id: 'c-1', name: 'n', dbType: 'MYSQL' as never, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection]);
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '5',
        records: [{ recordId: id, version: '2', changeSequence: '5', deleteTime: '2026-01-01T00:00:00.000Z' }],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store });
    const r = await eng.sync();
    expect(r.stage).toBe('conflict');
    expect(r.conflicts).toEqual([{ recordId: id, kind: 'pending' }]);
    expect(r.changeSequence).toBe('0');
  });

  it('cursor 持久化失败 → error，下次 sync() 仍可启动', async () => {
    const id = 'A'.repeat(22);
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '3' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '3',
        records: [{ recordId: id, version: '2', changeSequence: '3', deleteTime: '2026-01-01T00:00:00.000Z' }],
      })),
    });
    const eng = engine({
      client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      setImpl: async () => { throw new Error('write failed'); },
    });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.changeSequence).toBe('0');
    const r2 = await eng.sync(); // 单飞已清空，可再次启动
    expect(r2).toBeTruthy();
  });

  it('第二页 snapshotSequence 漂移 → error，第二页不提交 cursor', async () => {
    const id = 'A'.repeat(22);
    const setSnapshot = vi.fn(async () => {});
    const rec = { recordId: id, version: '2', changeSequence: '3', deleteTime: '2026-01-01T00:00:00.000Z' };
    const getRecords = vi.fn()
      .mockResolvedValueOnce({ snapshotSequence: '5', nextAfter: '3', records: [rec] })
      .mockResolvedValueOnce({ snapshotSequence: '99', records: [rec] });
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords,
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => SNAP, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
    });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('snapshotSequence drift');
    expect(setSnapshot).toHaveBeenCalledTimes(1);
    expect(setSnapshot).toHaveBeenCalledWith({ keyEpoch: '1', stateVersion: '1', changeSequence: '3' });
  });

  it('分页停滞（nextAfter 未前进）→ error', async () => {
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', nextAfter: '0', records: [] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('paging stalled');
  });

  it('构造函数拒绝 userId 不匹配的 mapStore / outbox', () => {
    const base = {
      keyEpoch: '1', client: clientWith(),
      stateStore: { getSnapshot: () => SNAP, setSnapshot: async () => {} } as never,
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
    };
    expect(() => new SyncEngine({
      ...base, userId: '7',
      mapStore: new RecordMapStore(makeMemento(), '8', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
    })).toThrowError(/mapStore userId mismatch/);
    expect(() => new SyncEngine({
      ...base, userId: '7',
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '8', '1'),
    })).toThrowError(/outbox userId mismatch/);
  });

  it('同 epoch、stateVersion 变化、空 feed → 更新快照', async () => {
    const setSnapshot = vi.fn(async () => {});
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '2', changeSequence: '0' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '0', records: [] })),
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => SNAP, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
    });
    const r = await eng.sync();
    expect(r.stage).toBe('ok');
    expect(setSnapshot).toHaveBeenCalledWith({ keyEpoch: '1', stateVersion: '2', changeSequence: '0' });
  });

  it('同 epoch、远端 stateVersion 低于本地 → error，不进 outbox/feed，不覆写快照', async () => {
    const setSnapshot = vi.fn(async () => {});
    const getRecords = vi.fn(async () => ({ snapshotSequence: '0', records: [] }));
    const localSnap: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '2', changeSequence: '0' };
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' })),
      getRecords,
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => localSnap, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
    });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('behind local');
    expect(setSnapshot).not.toHaveBeenCalled();
    expect(getRecords).not.toHaveBeenCalled();
  });

  it('SYNC_NONCE_REUSED → terminal，保留 outbox 条目', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_NONCE_REUSED'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.terminal?.code).toBe('SYNC_NONCE_REUSED');
    expect(outbox.list()).toHaveLength(1);
    expect(client.getRecords).not.toHaveBeenCalled();
  });

  it('SYNC_NOT_INITIALIZED → terminal(state)，reason 可识别', async () => {
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.reason).toContain('init');
    expect(outbox.list()).toHaveLength(1);
  });

  it('SYNC_EPOCH_STALE → terminal(epoch)，携带 currentKeyEpoch', async () => {
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_EPOCH_STALE', undefined, '3'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.terminal?.code).toBe('SYNC_EPOCH_STALE');
    expect(r.terminal?.currentKeyEpoch).toBe('3');
  });

  it('SYNC_VERSION_CONFLICT → conflict，携带 recordId/code/currentVersion，保留条目', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_VERSION_CONFLICT', '7'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('conflict');
    expect(r.conflicts[0]).toMatchObject({ recordId: m.recordId, kind: 'version', code: 'SYNC_VERSION_CONFLICT', currentVersion: '7' });
    expect(outbox.list()).toHaveLength(1);
  });

  it('可重试错误 → error，保留条目，consecutiveFailureCount 递增', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(500); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(outbox.list()[0].consecutiveFailureCount).toBe(1);
  });

  it('failure-count 落盘失败 → error（结构化），保留条目，不进 pull', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(500); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    vi.spyOn(outbox, 'setFailureCount').mockRejectedValueOnce(new Error('count write failed'));
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('failure-count commit failed');
    expect(outbox.list()).toHaveLength(1);
    expect(client.getRecords).not.toHaveBeenCalled();
  });

  it('连续失败 5 轮 → 附 stalled，允许 pull', async () => {
    const m = putMutation();
    const client = clientWith({
      putRecordSigned: vi.fn(async () => { throw new SyncApiError(500); }),
      getRecords: vi.fn(async () => ({ snapshotSequence: '0', records: [] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    for (let i = 0; i < 4; i++) {
      const r = await eng.sync();
      expect(r.stage).toBe('error');
      expect(r.stalled).toBeUndefined();
    }
    expect(client.getRecords).not.toHaveBeenCalled();
    const r5 = await eng.sync();
    expect(r5.stage).toBe('ok');
    expect(r5.stalled).toEqual({ mutationId: m.mutationId });
    expect(client.getRecords).toHaveBeenCalled();
  });

  it('push 成功 → 确认写回 recordVersion/revision/status → outbox 清空', async () => {
    const m = putMutation();
    const client = clientWith();
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('ok');
    expect(outbox.list()).toHaveLength(0);
    expect(mapStore.getByRef({ type: 'connection', localId: 'c-1' })).toEqual({
      recordId: m.recordId, type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed',
    });
  });

  it('delete 成功 → 删映射 + outbox 清空', async () => {
    const del: PendingDeleteMutation = {
      action: 'record.delete', recordId: 'A'.repeat(22), type: 'connection', localId: 'c-1', baseVersion: '1',
      mutationId: 'B'.repeat(22), signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43),
      revision: 0, consecutiveFailureCount: 0,
    };
    const client = clientWith();
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(del);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    const eng = engine({ client, snap: SNAP, mapStore, outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('ok');
    expect(outbox.list()).toHaveLength(0);
    expect(mapStore.getByRef({ type: 'connection', localId: 'c-1' })).toBeUndefined();
  });

  it('确认写失败 → 条目保留 → 重放同 receipt → 确认 → 删除', async () => {
    const store = new Map<string, unknown>();
    let failWrite = true;
    const flaky = {
      get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
      update: async (k: string, v: unknown): Promise<void> => {
        if (failWrite) { failWrite = false; throw new Error('map write failed'); }
        store.set(k, v);
      },
    };
    const m = putMutation();
    const client = clientWith();
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const mapStore = new RecordMapStore(flaky, '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox });

    const r1 = await eng.sync();
    expect(r1.stage).toBe('error');
    expect(r1.reason).toContain('confirm failed');
    expect(outbox.list()).toHaveLength(1);
    expect(client.getRecords).not.toHaveBeenCalled();

    const r2 = await eng.sync();
    expect(r2.stage).toBe('ok');
    expect(outbox.list()).toHaveLength(0);
    expect(mapStore.getByRef({ type: 'connection', localId: 'c-1' })).toMatchObject({ recordVersion: '1', status: 'confirmed', revision: 0 });
  });

  it('push 回执不越过 pull 快照推进 cursor（并发 record 不永久跳过）', async () => {
    const setSnapshot = vi.fn(async () => {});
    // 并发场景：A 读快照 S=0，本地 push 收到回执 changeSequence=2（S+1 已被并发 B 占用）
    const client = clientWith({
      putRecordSigned: vi.fn(async () => ({ version: '1', changeSequence: '2' })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => SNAP, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox,
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
    });
    const r = await eng.sync();
    expect(r.stage).toBe('ok');
    // 本轮 pull 快照仍为 0：cursor 不得推进到回执的 2，否则永久越过并发 record 1
    expect(r.changeSequence).toBe('0');
    expect(setSnapshot).not.toHaveBeenCalled();
  });

  it('并发 record 落在回执与快照之间 → 下一轮从旧 cursor 重新拉取（两轮收敛）', async () => {
    const setSnapshot = vi.fn(async () => {});
    // 第一轮：快照 S=0，push 回执=2，feed 空；第二轮：快照=2，feed 返回并发 B 的 tombstone（seq=1）
    const client = clientWith({
      getState: vi.fn()
        .mockResolvedValueOnce(stateDto({ changeSequence: '0' }))
        .mockResolvedValueOnce(stateDto({ changeSequence: '2' })),
      putRecordSigned: vi.fn(async () => ({ version: '1', changeSequence: '2' })),
      getRecords: vi.fn()
        .mockResolvedValueOnce({ snapshotSequence: '0', records: [] })
        .mockResolvedValueOnce({
          snapshotSequence: '2',
          records: [{ recordId: 'B'.repeat(22), version: '1', changeSequence: '1', deleteTime: '2026-01-01T00:00:00.000Z' }],
        }),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => SNAP, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox,
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
    });

    const r1 = await eng.sync();
    expect(r1.stage).toBe('ok');
    expect(r1.changeSequence).toBe('0'); // 本轮不越过快照

    const r2 = await eng.sync();
    expect(r2.stage).toBe('ok');
    expect(r2.applied).toBe(1); // B 的 tombstone 被应用（未被永久跳过）
    expect(r2.changeSequence).toBe('1'); // cursor 收敛到并发 record 1
    expect(setSnapshot).toHaveBeenCalledWith({ keyEpoch: '1', stateVersion: '1', changeSequence: '1' });
  });

  it('receipt 缺 changeSequence → error', async () => {
    const client = clientWith({
      putRecordSigned: vi.fn(async () => ({ version: '1' }) as never),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('missing changeSequence');
  });

  it('parsePage 拒绝非法 cipherSuite/formatVersion → terminal', async () => {
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ changeSequence: '1' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '1',
        records: [{ recordId: 'A'.repeat(22), version: '1', changeSequence: '1', deleteTime: null, cipherSuite: 'CHACHA20', formatVersion: 1, nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22) }],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.reason).toContain('protocol unsupported');
  });

  it('parsePage 拒绝 tombstone 携带密文字段 → terminal', async () => {
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ changeSequence: '1' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '1',
        records: [{ recordId: 'A'.repeat(22), version: '1', changeSequence: '1', deleteTime: '2026-01-01T00:00:00.000Z', nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22) }],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.reason).toContain('protocol unsupported');
  });
});