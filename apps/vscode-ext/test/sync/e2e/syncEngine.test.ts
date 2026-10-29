import { describe, expect, it, vi } from 'vitest';
import { sealRecord, encodeRecordPayload } from '@devbelt/db-host/sync/e2e/recordCodec';
import { DeferredRecordStore } from '@devbelt/db-host/sync/e2e/deferredRecordStore';
import { SyncEngine, SYNC_CANCELLED_REASON } from '@devbelt/db-host/sync/e2e/syncEngine';
import { SyncApiError, type PersonalSyncClient } from '@devbelt/db-host/sync/e2e/client';
import { RecordMapStore } from '@devbelt/db-host/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingDeleteMutation, type PendingPutMutation } from '@devbelt/db-host/sync/e2e/pendingMutationStore';
import type { SyncStateSnapshot } from '@devbelt/db-host/sync/e2e/stateStore';
import { EntityStore, UnresolvedRefStore, type EntityBackend } from '@devbelt/db-host/sync/e2e/entityStore';
import type { SyncEntityType } from '@devbelt/db-host/sync/e2e/syncEntity';
import { SyncMutator } from '@devbelt/db-host/sync/e2e/syncMutator';
import type { SavedConnection, ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import type { StateDto } from '@devbelt/db-host/sync/e2e/types';

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
    envelopeAccountVersion: '1',
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
  /** 验证器三类实体后端（宿主注入；relink/verify 测试用）。 */
  authenticatorBackend?: EntityBackend;
  setImpl?: (s: SyncStateSnapshot) => Promise<void>;
  signSeed?: () => Uint8Array;
  onEntityPushed?: (ref: { type: string; localId: string }) => void | Promise<void>;
  onQuotaRejected?: (ref: { type: string; localId: string }) => void | Promise<void>;
  /** 选择性同步：false 的类型停用（入站 deferred / 出站过滤 / 体检不计）。 */
  typeEnabled?: (type: SyncEntityType) => boolean;
}

function engine(opts: EngineOpts) {
  const store = opts.store ?? makeStore();
  const memento = makeMemento();
  const entities = new EntityStore(store, opts.authenticatorBackend, undefined, undefined, opts.typeEnabled);
  const signSeed = opts.signSeed ?? (() => new Uint8Array(32));
  const mutator = new SyncMutator({
    userId: '7', keyEpoch: '1', entities, mapStore: opts.mapStore, outbox: opts.outbox,
    dek: () => new Uint8Array(32), signSeed,
  });
  return new SyncEngine({
    userId: '7',
    keyEpoch: '1',
    client: opts.client,
    stateStore: makeStateStore(opts.snap, opts.setImpl) as never,
    mapStore: opts.mapStore,
    outbox: opts.outbox,
    entities,
    unresolved: new UnresolvedRefStore(memento, '7', '1'),
    dek: () => new Uint8Array(32),
    signSeed,
    uniqueId: () => `c-new-${Math.random()}`,
    seedConflictCarrier: (recordId, ref, baseVersion) => mutator.rebasePut(recordId, ref, baseVersion),
    buildLocalPut: (recordId, ref, baseVersion) => mutator.rebasePut(recordId, ref, baseVersion),
    buildLocalDelete: (recordId, ref, baseVersion) => mutator.rebaseDelete(recordId, ref, baseVersion),
    buildCloudDelete: (recordId, type, baseVersion) => mutator.buildCloudDelete(recordId, type, baseVersion),
    onEntityPushed: opts.onEntityPushed,
    onQuotaRejected: opts.onQuotaRejected,
    typeEnabled: opts.typeEnabled,
  });
}

const SNAP: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '1', changeSequence: '0' };

/** 不涉及 pending 冲突的用例：提供永不调用的 carrier 以满足必填 deps。 */
const seedConflictStub = (): ReturnType<SyncMutator['rebasePut']> => {
  throw new Error('seedConflictCarrier not exercised in this test');
};

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

  it('push 收到 SYNC_QUOTA_EXCEEDED → terminal 并回调 onQuotaRejected（P6 §六）', async () => {
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const m = putMutation();
    await outbox.put(m);
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_QUOTA_EXCEEDED'); }) });
    const rejected: Array<{ type: string; localId: string }> = [];
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox, onQuotaRejected: (ref) => { rejected.push(ref); } });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(rejected).toEqual([{ type: 'connection', localId: 'c-1' }]);
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

  it('outbox 重放 409 SYNC_VERSION_CONFLICT 缺 currentVersion → terminal（fail-closed，不重试不重签）', async () => {
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_VERSION_CONFLICT'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const m = putMutation();
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.terminal).toEqual({ mutationId: m.mutationId, code: 'SYNC_VERSION_CONFLICT' });
    expect(client.putRecordSigned).toHaveBeenCalledTimes(1);
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0].conflict).toBeUndefined();
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
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store });
    const r = await eng.sync();
    expect(r.stage).toBe('conflict');
    expect(r.conflicts).toMatchObject([{ recordId: id, kind: 'pending' }]);
    expect(r.changeSequence).toBe('0');
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0].conflict).toMatchObject({ kind: 'pending', remoteTombstone: true });
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
      seedConflictCarrier: seedConflictStub,
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
      seedConflictCarrier: seedConflictStub,
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
      seedConflictCarrier: seedConflictStub,
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
      seedConflictCarrier: seedConflictStub,
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

  it('SYNC_VERSION_CONFLICT → 持久化 conflict 后继续 pull（空 feed）→ 以 conflict 收尾，条目保留待下轮补密文', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_VERSION_CONFLICT', '7'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('conflict'); // C2：出站冲突即使本轮 pull 未命中远端也以 conflict 收尾，使 coordinator stalled
    expect(r.conflicts[0]).toMatchObject({ recordId: m.recordId, kind: 'version', code: 'SYNC_VERSION_CONFLICT', currentVersion: '7' });
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.list()[0].conflict).toMatchObject({ kind: 'version', currentVersion: '7', remoteRecordVersion: '7' });
  });

  it('C1：已标记 conflict 的 mutation 不再重复 push（第二轮跳过）', async () => {
    const m = putMutation();
    const putRecordSigned = vi.fn(async () => { throw new SyncApiError(409, 'SYNC_VERSION_CONFLICT', '7'); });
    const client = clientWith({ putRecordSigned });
    const memento = makeMemento();
    const outbox = new PendingMutationStore(memento, '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(memento, '7', '1'), outbox });

    await eng.sync(); // 第一轮：出站冲突，setConflict
    expect(outbox.list()[0].conflict).toBeDefined();

    await eng.sync(); // 第二轮：循环开头 skip 已 conflict 的 mutation
    expect(putRecordSigned).toHaveBeenCalledTimes(1);
    expect(outbox.list()[0].conflict).toBeDefined();
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

  it('鉴权失败（401）→ terminal，不消耗重试次数、不进入 pull', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(401); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.reason).toBe('authentication expired');
    expect(outbox.list()[0].consecutiveFailureCount).toBe(0);
    expect(client.getRecords).not.toHaveBeenCalled();
  });

  it('403 SYNC_SIGNATURE_INVALID → terminal，不误报为登录过期', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(403, 'SYNC_SIGNATURE_INVALID'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.terminal?.code).toBe('SYNC_SIGNATURE_INVALID');
    expect(r.reason).toBeUndefined();
    expect(outbox.list()[0].consecutiveFailureCount).toBe(0);
  });

  it('403 PERSONAL_FEATURE_REQUIRED → terminal（套餐不允许同步，不空转重试）', async () => {
    const m = putMutation();
    const client = clientWith({ putRecordSigned: vi.fn(async () => { throw new SyncApiError(403, 'PERSONAL_FEATURE_REQUIRED'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(m);
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.terminal?.code).toBe('PERSONAL_FEATURE_REQUIRED');
    expect(r.reason).toBeUndefined();
    expect(outbox.list()[0].consecutiveFailureCount).toBe(0);
  });

  it('getState 401 → terminal（不再当临时故障重试）', async () => {
    const client = clientWith({ getState: vi.fn(async () => { throw new SyncApiError(401); }) });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.reason).toBe('authentication expired');
  });

  it('getRecords 401 → terminal', async () => {
    const client = clientWith({ getRecords: vi.fn(async () => { throw new SyncApiError(401); }) });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.reason).toBe('authentication expired');
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
      seedConflictCarrier: seedConflictStub,
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
      seedConflictCarrier: seedConflictStub,
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

  it('parsePage 拒绝非字符串 nextAfter（不得静默当作结束页） → terminal', async () => {
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ changeSequence: '1' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '1',
        nextAfter: 123,
        records: [{ recordId: 'A'.repeat(22), version: '1', changeSequence: '1', deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1, nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22) }],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox: new PendingMutationStore(makeMemento(), '7', '1') });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.reason).toContain('nextAfter must be a string');
  });

  it('pending 入站冲突无 outbox 条目 → 构造 conflict carrier 持久化（可被 listConflicts 发现）', async () => {
    const id = 'A'.repeat(22);
    const memento = makeMemento();
    const mapStore = new RecordMapStore(memento, '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'pending' });
    const store = makeStore([{ id: 'c-1', name: 'n', dbType: 'MYSQL' as never, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection]);
    const outbox = new PendingMutationStore(memento, '7', '1');
    const entities = new EntityStore(store);
    const mutator = new SyncMutator({
      userId: '7', keyEpoch: '1', entities, mapStore, outbox,
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32),
    });
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '5',
        records: [{ recordId: id, version: '2', changeSequence: '5', deleteTime: '2026-01-01T00:00:00.000Z' }],
      })),
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: makeStateStore(SNAP) as never, mapStore, outbox, entities,
      unresolved: new UnresolvedRefStore(memento, '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32),
      uniqueId: () => 'new-1',
      seedConflictCarrier: (rid, ref, bv) => mutator.rebasePut(rid, ref, bv),
    });

    const r = await eng.sync();
    expect(r.stage).toBe('conflict');
    const listed = outbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].conflict).toMatchObject({ kind: 'pending', remoteTombstone: true });
  });
});

describe('SyncEngine · deferred（权益跳过的连接记录）', () => {
  const FREE = { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 2, maxSavedConnections: 10, allowConnectionImport: false };
  const PRO = { ...FREE, allowedDatabaseTypes: ['mysql', 'sqlite', 'postgresql'] };

  function remotePg(version = '1') {
    const recordId = 'A'.repeat(22);
    const dek = new Uint8Array(32);
    const nonce = new Uint8Array(12).fill(1);
    const plaintext = Buffer.from(JSON.stringify({ type: 'connection', name: 'pg', dbType: 'postgresql', host: 'h', port: 5432, user: 'u', password: 'p' }), 'utf8');
    const box = sealRecord(dek, nonce, plaintext, { userId: '7', keyEpoch: '1', recordId, recordVersion: version });
    return {
      recordId,
      version,
      changeSequence: '5',
      deleteTime: null,
      cipherSuite: 'AES-256-GCM',
      formatVersion: 1,
      nonce: Buffer.from(nonce).toString('base64url'),
      ciphertext: Buffer.from(box.ciphertext).toString('base64url'),
      tag: Buffer.from(box.tag).toString('base64url'),
    };
  }

  it('redis 连接（free 含 redis）经 pull 落地并可见', async () => {
    const store = makeStore();
    const memento = makeMemento();
    const entities = new EntityStore(store);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const unresolved = new UnresolvedRefStore(memento, '7', '1');
    const deferred = new DeferredRecordStore(memento, '7', '1');
    const dek = new Uint8Array(32);
    const recordId = 'B'.repeat(22);
    const nonce = new Uint8Array(12).fill(2);
    const plaintext = Buffer.from(JSON.stringify({ type: 'connection', name: 'redis-1', dbType: 'redis', host: 'h', port: 6379, user: '', redisMode: 'standalone', redisDb: 1 }), 'utf8');
    const box = sealRecord(dek, nonce, plaintext, { userId: '7', keyEpoch: '1', recordId, recordVersion: '1' });
    const rec = {
      recordId, version: '1', changeSequence: '5', deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: Buffer.from(nonce).toString('base64url'), ciphertext: Buffer.from(box.ciphertext).toString('base64url'), tag: Buffer.from(box.tag).toString('base64url'),
    };
    const entitlement = { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite', 'redis'], maxDevices: 2, maxSavedConnections: 10, allowConnectionImport: false };
    const engine = new SyncEngine({
      userId: '7', keyEpoch: '1',
      client: clientWith({
        getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
        getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
      }),
      stateStore: makeStateStore(SNAP) as never,
      mapStore, outbox, entities, unresolved, deferred,
      dek: () => dek, signSeed: () => new Uint8Array(32), uniqueId: () => 'c-redis-1',
      entitlement: () => entitlement,
      seedConflictCarrier: seedConflictStub,
    });
    const r = await engine.sync();
    expect(r.stage).toBe('ok');
    expect(deferred.list()).toHaveLength(0);
    const conns = store.listForSync().filter((c) => !(c as unknown as { deleted?: boolean }).deleted);
    expect(conns).toHaveLength(1);
    expect((conns[0] as unknown as { dbType: string }).dbType).toBe('REDIS');
    expect((conns[0] as unknown as { redisDb?: number }).redisDb).toBe(1);
  });

  it('free 用户 PG 连接入 deferred 且不落地；升级后下一轮 drain 落地', async () => {
    const store = makeStore();
    const memento = makeMemento();
    const entities = new EntityStore(store);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const unresolved = new UnresolvedRefStore(memento, '7', '1');
    const deferred = new DeferredRecordStore(memento, '7', '1');
    const dek = new Uint8Array(32);
    const rec = remotePg();

    let entitlement = FREE;
    const build = (client: PersonalSyncClient) =>
      new SyncEngine({
        userId: '7', keyEpoch: '1', client,
        stateStore: makeStateStore(SNAP) as never,
        mapStore, outbox, entities, unresolved, deferred,
        dek: () => dek, signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
        entitlement: () => entitlement,
        seedConflictCarrier: seedConflictStub,
      });

    const client1 = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
    });
    const r1 = await build(client1).sync();
    expect(r1.stage).toBe('ok');
    expect(r1.skippedEntitlement).toBe(1);
    expect(deferred.list()).toHaveLength(1);
    expect(store.listForSync().filter((c) => !(c as unknown as { deleted?: boolean }).deleted)).toHaveLength(0);

    entitlement = PRO;
    const client2 = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [] })),
    });
    const r2 = await build(client2).sync();
    expect(r2.stage).toBe('ok');
    expect(deferred.list()).toHaveLength(0);
    const conns = store.listForSync().filter((c) => !(c as unknown as { deleted?: boolean }).deleted);
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe('pg');
  });

  it('deferred 中的记录收到远端墓碑 → 清除 deferred（不复活已删连接）', async () => {
    const store = makeStore();
    const memento = makeMemento();
    const entities = new EntityStore(store);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const unresolved = new UnresolvedRefStore(memento, '7', '1');
    const deferred = new DeferredRecordStore(memento, '7', '1');
    const dek = new Uint8Array(32);
    const rec = remotePg();
    const entitlement = FREE;
    const build = (client: PersonalSyncClient) =>
      new SyncEngine({
        userId: '7', keyEpoch: '1', client,
        stateStore: makeStateStore(SNAP) as never,
        mapStore, outbox, entities, unresolved, deferred,
        dek: () => dek, signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
        entitlement: () => entitlement,
        seedConflictCarrier: seedConflictStub,
      });

    const r1 = await build(clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
    })).sync();
    expect(r1.skippedEntitlement).toBe(1);
    expect(deferred.list()).toHaveLength(1);

    const tomb = {
      recordId: rec.recordId, version: '2', changeSequence: '6', deleteTime: 1700000000,
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
    };
    const r2 = await build(clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '6' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '6', records: [tomb] })),
    })).sync();
    expect(r2.stage, r2.reason).toBe('ok');
    expect(deferred.list()).toHaveLength(0);
  });

  it('未知引擎记录跳过（skipped-unsupported）且不阻断同页其它记录', async () => {
    const store = makeStore();
    const memento = makeMemento();
    const entities = new EntityStore(store);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const unresolved = new UnresolvedRefStore(memento, '7', '1');
    const deferred = new DeferredRecordStore(memento, '7', '1');
    const dek = new Uint8Array(32);
    const seal = (recordId: string, fill: number, payload: Record<string, unknown>) => {
      const nonce = new Uint8Array(12).fill(fill);
      const box = sealRecord(dek, nonce, Buffer.from(JSON.stringify(payload), 'utf8'), { userId: '7', keyEpoch: '1', recordId, recordVersion: '1' });
      return {
        recordId, version: '1', changeSequence: '5', deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: Buffer.from(nonce).toString('base64url'), ciphertext: Buffer.from(box.ciphertext).toString('base64url'), tag: Buffer.from(box.tag).toString('base64url'),
      };
    };
    const unsupported = seal('E'.repeat(22), 3, { type: 'connection', name: 'x', dbType: 'graphdb', host: 'h', port: 9200 });
    const supported = seal('F'.repeat(22), 4, { type: 'connection', name: 'redis-ok', dbType: 'redis', host: 'h', port: 6379, user: '', redisMode: 'standalone', redisDb: 0 });

    const entitlement = { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite', 'redis'], maxDevices: 2, maxSavedConnections: 10, allowConnectionImport: false };
    const engine = new SyncEngine({
      userId: '7', keyEpoch: '1',
      client: clientWith({
        getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
        getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [unsupported, supported] })),
      }),
      stateStore: makeStateStore(SNAP) as never,
      mapStore, outbox, entities, unresolved, deferred,
      dek: () => dek, signSeed: () => new Uint8Array(32), uniqueId: () => 'c-u-1',
      entitlement: () => entitlement,
      seedConflictCarrier: seedConflictStub,
    });

    const r = await engine.sync();
    expect(r.stage).toBe('ok');
    expect(r.skippedUnsupported).toBe(1);
    expect(deferred.list()).toHaveLength(1);
    const names = store.listForSync().filter((c) => !(c as unknown as { deleted?: boolean }).deleted).map((c) => c.name);
    expect(names).toContain('redis-ok');
    expect(names).not.toContain('es');
  });

  it('已映射的 PG 连接在 free 下也入 deferred；升级后 drain 更新该连接', async () => {
    const store = makeStore([{ id: 'c-old', name: 'pg-old', dbType: 'postgresql' as never, host: 'h', port: 5432, user: 'u', updateTime: 100 } as SavedConnection]);
    const memento = makeMemento();
    const entities = new EntityStore(store);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const unresolved = new UnresolvedRefStore(memento, '7', '1');
    const deferred = new DeferredRecordStore(memento, '7', '1');
    const rec = remotePg('2');
    // 已有 confirmed 映射（recordVersion 1 < 远端 2）；revision 取大值，避免本地 updateTime 触发脏冲突。
    await mapStore.put(rec.recordId, { type: 'connection', localId: 'c-old', recordVersion: '1', revision: 9_999_999_999_999, status: 'confirmed' });

    let entitlement = FREE;
    const build = (client: PersonalSyncClient) =>
      new SyncEngine({
        userId: '7', keyEpoch: '1', client,
        stateStore: makeStateStore(SNAP) as never,
        mapStore, outbox, entities, unresolved, deferred,
        dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
        entitlement: () => entitlement,
        seedConflictCarrier: seedConflictStub,
      });

    const client1 = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
    });
    const r1 = await build(client1).sync();
    expect(r1.stage).toBe('ok');
    // 关键：已映射的权益跳过也必须入 deferred，否则游标越过后永久丢失更新。
    expect(deferred.list()).toHaveLength(1);

    entitlement = PRO;
    const client2 = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [] })),
    });
    const r2 = await build(client2).sync();
    expect(r2.stage).toBe('ok');
    expect(deferred.list()).toHaveLength(0);
    expect(store.listForSync().find((c) => c.id === 'c-old')?.name).toBe('pg');
  });

  it('deferred 中的墓碑（未落地）不被物化', async () => {
    const store = makeStore();
    const memento = makeMemento();
    const deferred = new DeferredRecordStore(memento, '7', '1');
    // 直接写入一条已删除记录的墓碑，模拟「跳过期间远端已删」。
    await deferred.put({ recordId: 'A'.repeat(22), version: '2', changeSequence: '6', deleteTime: '2026-01-01T00:00:00.000Z' });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1',
      client: clientWith({
        getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '6' })),
        getRecords: vi.fn(async () => ({ snapshotSequence: '6', records: [] })),
      }),
      stateStore: makeStateStore(SNAP) as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(store),
      unresolved: new UnresolvedRefStore(memento, '7', '1'),
      deferred,
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
      entitlement: () => PRO,
      seedConflictCarrier: seedConflictStub,
    });
    const r = await eng.sync();
    expect(r.stage).toBe('ok');
    expect(deferred.list()).toHaveLength(0);
    expect(store.listForSync().filter((c) => !(c as unknown as { deleted?: boolean }).deleted)).toHaveLength(0);
  });

});

describe('SyncEngine 本地缺失修复（S7k）', () => {
  const u8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

  function aliveConnectionRecord(recordId: string, version: string, sequence: string) {
    const conn = { id: 'c-old', name: 'lost', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u' } as unknown as SavedConnection;
    const payload = encodeRecordPayload(conn);
    const nonce = new Uint8Array(12);
    const box = sealRecord(
      new Uint8Array(32),
      nonce,
      new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8')),
      { userId: '7', keyEpoch: '1', recordId, recordVersion: version },
    );
    return {
      recordId, version, changeSequence: sequence, deleteTime: null,
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: u8(nonce), ciphertext: u8(box.ciphertext), tag: u8(box.tag),
    };
  }

  it('repairLocalMissing：远端存活 + 本地实体缺失（同版本）→ force 重放，缺失清零', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [aliveConnectionRecord(id, '1', '5')] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store: makeStore() });

    const before = await eng.inspectFindings();
    expect(before.findings).toEqual([
      { id: 'missing:connection:c-lost', kind: 'missing', type: 'connection', recordId: id, localId: 'c-lost', remoteValue: 'lost' },
    ]);

    const r = await eng.repairFindings();
    expect(r).toMatchObject({ cloud: 1, failed: 0 });
    expect((await eng.inspectFindings()).findings).toEqual([]);
  });

  it('repairFindings：有未决出站变更 → 归入 pendingLocal，不修复也不拉取', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put({ ...putMutation(), recordId: id, localId: 'c-lost' });
    const client = clientWith();
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store: makeStore() });

    const report = await eng.inspectFindings();
    expect(report.findings).toEqual([]); // 有待推出站 → 尊重意图，不产生发现

    const r = await eng.repairFindings();
    expect(r).toEqual({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0 });
    expect(client.putRecordSigned).not.toHaveBeenCalled();
    expect(client.deleteRecordSigned).not.toHaveBeenCalled();
  });

  it('inspectFindings：云端查无该记录 → 不产生发现（无法判定，不当 notFound 虚报）', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store: makeStore() });

    const report = await eng.inspectFindings();
    expect(report.findings).toEqual([]);
    expect(report.incomplete).toBe(false);
    const r = await eng.repairFindings();
    expect(r).toEqual({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0 });
  });

  it('repairLocalMissing：本地墓碑 + 云端存活 → 复活（清 deleted）', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const store = makeStore([
      { id: 'c-lost', name: 'gone', dbType: 'MYSQL', host: 'h', port: 3306, deleted: true, updateTime: 0 } as unknown as SavedConnection,
    ]);
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [aliveConnectionRecord(id, '1', '5')] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store });

    expect((await eng.inspectFindings()).findings).toHaveLength(1);
    const r = await eng.repairFindings();
    expect(r).toMatchObject({ cloud: 1, failed: 0 });
    expect((await eng.inspectFindings()).findings).toEqual([]);
    expect((store.get('c-lost') as unknown as { deleted?: boolean } | undefined)?.deleted).toBeFalsy();
  });

  it('repairFindings：云端记录引擎不在套餐内 → blocked，不谎报已修复', async () => {
    // 复现用户场景：本地删除了一个 Elasticsearch 连接，云端仍在，点「使用云端」。
    // Free 套餐不允许 ES 个人连接 → applyRecord 返回 skipped-entitlement。
    // 修复必须报告 blocked 而不是 cloud，否则体检会无限重复同一条。
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-es', recordVersion: '1', revision: 0, status: 'confirmed' });
    const store = makeStore([
      { id: 'c-es', name: '订单', dbType: 'ELASTICSEARCH', host: 'h', port: 9200, deleted: true, updateTime: 0 } as unknown as SavedConnection,
    ]);
    const esRecord = (() => {
      const conn = { id: 'c-old', name: '订单', dbType: 'ELASTICSEARCH', host: 'h', port: 9200 } as unknown as SavedConnection;
      const payload = encodeRecordPayload(conn);
      const nonce = new Uint8Array(12);
      const box = sealRecord(
        new Uint8Array(32),
        nonce,
        new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8')),
        { userId: '7', keyEpoch: '1', recordId: id, recordVersion: '2' },
      );
      return {
        recordId: id, version: '2', changeSequence: '5', deleteTime: null,
        cipherSuite: 'AES-256-GCM', formatVersion: 1,
        nonce: u8(nonce), ciphertext: u8(box.ciphertext), tag: u8(box.tag),
      };
    })();
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [esRecord] })),
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1',
      client,
      stateStore: makeStateStore(SNAP) as never,
      mapStore,
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(store),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
      entitlement: () => ({ planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 2, maxSavedConnections: 10, allowConnectionImport: false }),
      seedConflictCarrier: seedConflictStub,
    });

    expect((await eng.inspectFindings()).findings).toHaveLength(1);
    const r = await eng.repairFindings();
    expect(r).toMatchObject({ cloud: 0, blocked: 1, blockedBy: 'entitlement', failed: 0 });
    // 本地仍是墓碑，云端也没被改：数据没有静默丢失或被误合并。
    expect((store.get('c-es') as unknown as { deleted?: boolean } | undefined)?.deleted).toBe(true);
  });

  it('repairLocalMissing：本地墓碑 + 云端墓碑 → 应用墓碑并删映射（向云端收敛）', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const store = makeStore([
      { id: 'c-lost', name: 'gone', dbType: 'MYSQL', host: 'h', port: 3306, deleted: true, updateTime: 0 } as unknown as SavedConnection,
    ]);
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '5',
        records: [{ recordId: id, version: '2', changeSequence: '5', deleteTime: '2026-01-01T00:00:00.000Z' }],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store });

    const r = await eng.repairFindings();
    expect(r).toMatchObject({ cloud: 1, failed: 0 });
    expect(mapStore.getByRecordId(id)).toBeUndefined();
    expect((await eng.inspectFindings()).findings).toEqual([]);
  });

  it('孤儿墓碑（较新本地删除且无待推出站）：检出 orphanDelete；修复以云端为准复活；幂等', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const store = makeStore([
      { id: 'c-lost', name: 'gone', dbType: 'MYSQL', host: 'h', port: 3306, deleted: true, updateTime: 999999 } as unknown as SavedConnection,
    ]);
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [aliveConnectionRecord(id, '1', '5')] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store });

    const report = await eng.inspectFindings();
    expect(report.findings).toEqual([
      { id: `orphanDelete:connection:c-lost`, kind: 'orphanDelete', type: 'connection', recordId: id, localId: 'c-lost', localValue: 'gone', remoteValue: 'lost' },
    ]);
    const r = await eng.repairFindings();
    expect(r.cloud).toBe(1);
    expect((store.get('c-lost') as unknown as { deleted?: boolean } | undefined)?.deleted).toBeFalsy();
    const again = await eng.repairFindings();
    expect(again).toEqual({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0 });
  });

  it('孤儿墓碑有待推出站（真实删除意图）→ 尊重意图：不检出、不修复也不拉取', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const store = makeStore([
      { id: 'c-lost', name: 'gone', dbType: 'MYSQL', host: 'h', port: 3306, deleted: true, updateTime: 999999 } as unknown as SavedConnection,
    ]);
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put({ ...putMutation(), recordId: id, localId: 'c-lost' });
    const client = clientWith();
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store });

    const report = await eng.inspectFindings();
    expect(report.findings).toEqual([]);
    const r = await eng.repairFindings();
    expect(r).toEqual({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0 });
    expect(client.putRecordSigned).not.toHaveBeenCalled();
    expect(client.deleteRecordSigned).not.toHaveBeenCalled();
    expect((store.get('c-lost') as unknown as { deleted?: boolean } | undefined)?.deleted).toBe(true);
  });

  it('repairFindings：远端 epoch 前进 → 零计数且带 aborted（不误报 failed，也不冒充「修了 0 条」）', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '2', stateVersion: '1', changeSequence: '1' })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store: makeStore() });

    const r = await eng.repairFindings();
    expect(r).toEqual({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0, aborted: 'remote keyEpoch differs from local' });
    expect(client.getRecords).not.toHaveBeenCalled();
  });

  it('inspectFindings：快照漂移 → incomplete=true，无发现（不虚报 notFound）', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '9', records: [aliveConnectionRecord(id, '1', '5')] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store: makeStore() });

    const report = await eng.inspectFindings();
    expect(report.incomplete).toBe(true);
    expect(report.findings).toEqual([]);
    const r = await eng.repairFindings();
    expect(r).toEqual({ cloud: 0, local: 0, merged: 0, swept: 0, failed: 0, notFound: 0, pending: 0, blocked: 0 });
  });

  function relinkStore(conn: SavedConnection, groups: Array<{ id: string; name: string }>) {
    const conns = new Map([[conn.id, conn]]);
    const gs = new Map(groups.map((g) => [g.id, g]));
    return {
      get: (id: string) => conns.get(id),
      save: async (c: SavedConnection) => { conns.set(c.id, { ...c, updateTime: (c as { updateTime?: number }).updateTime ?? Date.now() }); },
      remove: async (id: string) => { const c = conns.get(id); if (c) conns.set(id, { ...c, deleted: true }); },
      listForSync: () => [...conns.values()],
      listGroupsForSync: () => [...gs.values()].map((g) => ({ ...g, deleted: false, updateTime: 1 })),
      listFoldersForSync: () => [],
      listQueriesForSync: () => [],
      getGroupById: (id: string) => gs.get(id),
      getFolderById: () => undefined,
      getQueryById: () => undefined,
      upsertGroup: async (g: { id: string; name: string }) => { const e = gs.get(g.id); if (e) { e.name = g.name; (e as { updateTime?: number }).updateTime = Date.now(); } },
      upsertFolder: async () => {},
      upsertQuery: async () => {},
      removeGroup: async () => {},
      removeQueryFolder: async () => {},
      removeQuery: async () => {},
    } as unknown as ConnectionStore;
  }

  function relinkClient(cRid: string, groupRecordId: string) {
    const payload = { type: 'connection', name: 'c', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: groupRecordId };
    const nonce = new Uint8Array(12);
    const box = sealRecord(
      new Uint8Array(32), nonce,
      new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8')),
      { userId: '7', keyEpoch: '1', recordId: cRid, recordVersion: '1' },
    );
    return clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '5',
        records: [{ recordId: cRid, version: '1', changeSequence: '5', deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1, nonce: u8(nonce), ciphertext: u8(box.ciphertext), tag: u8(box.tag) }],
      })),
    });
  }

  it('relink：连接 groupId 与云端不符 → force 重放校正为云端分组', async () => {
    const cRid = 'C'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put('H'.repeat(22), { type: 'group', localId: 'g2', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }, { id: 'g2', name: 'G2' }],
    );
    const client = relinkClient(cRid, 'H'.repeat(22));
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const r = await eng.repairFindings();
    expect(r.cloud).toBe(1); // 归属校正计入 cloud（恢复/更正/收敛删除统一计数）
    expect((store.get('c-1') as unknown as { groupId?: string } | undefined)?.groupId).toBe('g2');
  });

  it('relink：引用一致 → 不重放（relinked=0）', async () => {
    const cRid = 'D'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    const client = relinkClient(cRid, 'G'.repeat(22));
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const r = await eng.repairFindings();
    expect(r.cloud).toBe(0);
    expect(r.cloud).toBe(0);
  });


  function sealAlive(recordId: string, version: string, sequence: string, payload: Record<string, unknown>) {
    const nonce = new Uint8Array(12);
    const box = sealRecord(
      new Uint8Array(32), nonce,
      new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8')),
      { userId: '7', keyEpoch: '1', recordId, recordVersion: version },
    );
    return { recordId, version, changeSequence: sequence, deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1, nonce: u8(nonce), ciphertext: u8(box.ciphertext), tag: u8(box.tag) };
  }

  it('converge 幂等：第二次零写入（materialized/relinked/converged 全 0）', async () => {
    const cRid = 'E'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put('H'.repeat(22), { type: 'group', localId: 'g2', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }, { id: 'g2', name: 'G2' }],
    );
    const client = relinkClient(cRid, 'H'.repeat(22));
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const first = await eng.repairFindings();
    expect(first.cloud).toBe(1);
    const second = await eng.repairFindings();
    expect(second.cloud).toBe(0);
    expect(second.cloud).toBe(0);
    expect(second.cloud).toBe(0);
    expect((store.get('c-1') as unknown as { groupId?: string } | undefined)?.groupId).toBe('g2');
  });

  it('converge 隔离：只改漂移那条，其名称与另一条分组/连接均保持原样', async () => {
    const c1 = 'C'.repeat(22);
    const c2 = 'D'.repeat(22);
    const gG = 'G'.repeat(22);
    const gH = 'H'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gG, { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(gH, { type: 'group', localId: 'g2', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(c1, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(c2, { type: 'connection', localId: 'c-2', recordVersion: '1', revision: 1, status: 'confirmed' });

    const conns = new Map<string, SavedConnection>([
      ['c-1', { id: 'c-1', name: 'one', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection],
      ['c-2', { id: 'c-2', name: 'two', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g2', updateTime: 1 } as unknown as SavedConnection],
    ]);
    const gs = new Map<string, { id: string; name: string }>([['g1', { id: 'g1', name: 'G-one' }], ['g2', { id: 'g2', name: 'G-two' }]]);
    const store = {
      get: (id: string) => conns.get(id),
      save: async (c: SavedConnection) => { conns.set(c.id, { ...c, updateTime: (c as { updateTime?: number }).updateTime ?? Date.now() }); },
      remove: async (id: string) => { const c = conns.get(id); if (c) conns.set(id, { ...c, deleted: true }); },
      listForSync: () => [...conns.values()],
      listGroupsForSync: () => [...gs.values()].map((g) => ({ ...g, deleted: false, updateTime: 1 })),
      listFoldersForSync: () => [],
      listQueriesForSync: () => [],
      getGroupById: (id: string) => gs.get(id),
      getFolderById: () => undefined,
      getQueryById: () => undefined,
      upsertGroup: async (g: { id: string; name: string }) => { const e = gs.get(g.id); if (e) { e.name = g.name; (e as { updateTime?: number }).updateTime = Date.now(); } },
      upsertFolder: async () => {},
      upsertQuery: async () => {},
      removeGroup: async () => {},
      removeQueryFolder: async () => {},
      removeQuery: async () => {},
    } as unknown as ConnectionStore;

    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '5',
        records: [
          sealAlive(c1, '1', '5', { type: 'connection', name: 'one', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: gH }),
          sealAlive(c2, '2', '6', { type: 'connection', name: 'two', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: gH }),
        ],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const r = await eng.repairFindings();
    expect(r.cloud).toBe(1); // 仅 c-1 漂移（g1 → g2）
    expect((store.get('c-1') as unknown as { groupId?: string } | undefined)?.groupId).toBe('g2');
    expect((store.get('c-2') as unknown as { groupId?: string; name?: string } | undefined)?.groupId).toBe('g2');
    expect((store.get('c-2') as unknown as { name?: string } | undefined)?.name).toBe('two');
    expect(gs.get('g1')?.name).toBe('G-one');
    expect(gs.get('g2')?.name).toBe('G-two');
  });

  it('relink：分组名与云端不符 → force 重放恢复云端名，第二次零写入', async () => {
    const gRid = 'F'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gRid, { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-0', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: '亿贝安' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(gRid, '1', '5', { type: 'group', name: '天九-数科' })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const first = await eng.repairFindings();
    expect(first.cloud).toBe(1);
    expect((store.getGroupById('g1') as unknown as { name?: string } | undefined)?.name).toBe('天九-数科');
    const second = await eng.repairFindings();
    expect(second.cloud).toBe(0);
  });

  it('inspectFindings：分组名漂移 → 逐条发现（本机/云端对照），零写入', async () => {
    const gRid = 'K'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gRid, { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-0', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: '亿贝安' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(gRid, '1', '5', { type: 'group', name: '天九-数科' })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([
      { id: `nameDrift:group:g1`, kind: 'nameDrift', type: 'group', recordId: gRid, localId: 'g1', localValue: '亿贝安', remoteValue: '天九-数科' },
    ]);
    expect(v.incomplete).toBe(false);
    // 零写入：检测只比对，修复由用户在面板选择后触发。
    expect((store.getGroupById('g1') as unknown as { name?: string } | undefined)?.name).toBe('亿贝安');
  });

  it('inspectFindings：引用归属漂移 → 逐条发现（字段对照），零写入', async () => {
    const cRid = 'L'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put('H'.repeat(22), { type: 'group', localId: 'g2', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }, { id: 'g2', name: 'G2' }],
    );
    const client = relinkClient(cRid, 'H'.repeat(22));
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([
      { id: `refDrift:connection:c-1`, kind: 'refDrift', type: 'connection', recordId: cRid, localId: 'c-1', localValue: 'c', ref: { field: 'groupId', local: 'G1', remote: 'G2' } },
    ]);
    expect((store.get('c-1') as unknown as { groupId?: string } | undefined)?.groupId).toBe('g1');
  });

  it('inspectFindings：引用一致 → 无发现', async () => {
    const cRid = 'M'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    const client = relinkClient(cRid, 'G'.repeat(22));
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([]);
    expect(v.incomplete).toBe(false);
  });

  it('inspectFindings：快照漂移 → incomplete=true（面板提示重试，不当发现）', async () => {
    const gRid = 'N'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gRid, { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-0', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: '亿贝安' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '9', records: [sealAlive(gRid, '1', '5', { type: 'group', name: '天九-数科' })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const v = await eng.inspectFindings();
    expect(v.incomplete).toBe(true);
    expect(v.findings).toEqual([]);
  });

  function authGroupBackend(groups: Map<string, { id: string; name: string; sortOrder?: number; deleted?: boolean; updateTime?: number }>): EntityBackend {
    return {
      listForSync: () => [...groups.values()].map((g) => ({
        ref: { type: 'authenticatorGroup' as const, localId: g.id },
        deleted: !!g.deleted,
        updateTime: g.updateTime ?? 1,
      })),
      get: (ref) => groups.get(ref.localId) as never,
      save: async (ref, entity) => {
        const prev = groups.get(ref.localId) ?? { id: ref.localId, name: '' };
        groups.set(ref.localId, { ...prev, ...(entity as object), id: ref.localId, updateTime: Date.now() });
      },
      remove: async (ref) => { const g = groups.get(ref.localId); if (g) g.deleted = true; },
    };
  }

  it('验证器分组名漂移：检出 nameDrift 且零写入；修复按云端校准（relinked=1，幂等）', async () => {
    const gRid = 'P'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gRid, { type: 'authenticatorGroup', localId: 'ag1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const groups = new Map([['ag1', { id: 'ag1', name: '亿贝安' }]]);
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(gRid, '1', '5', { type: 'authenticatorGroup', name: '天九-数科', sortOrder: 0 })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), authenticatorBackend: authGroupBackend(groups) } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([
      { id: 'nameDrift:authenticatorGroup:ag1', kind: 'nameDrift', type: 'authenticatorGroup', recordId: gRid, localId: 'ag1', localValue: '亿贝安', remoteValue: '天九-数科' },
    ]);
    expect(groups.get('ag1')?.name).toBe('亿贝安');

    const r = await eng.repairFindings();
    expect(r.cloud).toBe(1);
    expect(groups.get('ag1')?.name).toBe('天九-数科');
    const again = await eng.repairFindings();
    expect(again.cloud).toBe(0);
  });

  it('孤儿空分组（无映射、无引用、非新建）：检出 orphanGroup；修复清理（swept=1），被引用的不清', async () => {
    const gRid = 'P'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gRid, { type: 'authenticatorGroup', localId: 'ag1', recordVersion: '1', revision: 1, status: 'confirmed' });
    // ag-mapped 有映射；ag-orphan 无映射无引用（updateTime 1 = 很久以前）；ag-referenced 无映射但有条目引用。
    const groups = new Map<string, { id: string; name: string; deleted?: boolean; updateTime?: number; sortOrder?: number }>([
      ['ag1', { id: 'ag1', name: 'G', updateTime: 1 }],
      ['ag-orphan', { id: 'ag-orphan', name: '多余的空组', updateTime: 1 }],
      ['ag-referenced', { id: 'ag-referenced', name: '有条目引用', updateTime: 1 }],
    ]);
    const entries = new Map<string, { id: string; groupId?: string; deleted?: boolean; updateTime?: number; issuer?: string; account?: string; algorithm?: string; digits?: number; period?: number; tags?: string[]; secret?: string }>([
      ['e1', { id: 'e1', groupId: 'ag-referenced', updateTime: 1, issuer: 'A' }],
    ]);
    const backend: EntityBackend = {
      listForSync: () => [
        ...[...groups.values()].map((g) => ({ ref: { type: 'authenticatorGroup' as const, localId: g.id }, deleted: !!g.deleted, updateTime: g.updateTime ?? 1 })),
        ...[...entries.values()].map((e) => ({ ref: { type: 'authenticatorEntry' as const, localId: e.id }, deleted: !!e.deleted, updateTime: e.updateTime ?? 1 })),
      ],
      get: (ref) => (ref.type === 'authenticatorGroup' ? groups.get(ref.localId) : entries.get(ref.localId)) as never,
      save: async () => {},
      remove: async (ref) => { groups.delete(ref.localId); entries.delete(ref.localId); },
    };
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(gRid, '1', '5', { type: 'authenticatorGroup', name: 'G', sortOrder: 0 })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), authenticatorBackend: backend } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toContainEqual({ id: 'orphanGroup:authenticatorGroup:ag-orphan', kind: 'orphanGroup', type: 'authenticatorGroup', localId: 'ag-orphan', localValue: '多余的空组' });
    expect(v.findings.some((f) => f.localId === 'ag-referenced' && f.kind === 'orphanGroup')).toBe(false);

    const r = await eng.repairFindings();
    expect(r.swept).toBe(1);
    expect(groups.has('ag-orphan')).toBe(false);
    expect(groups.has('ag-referenced')).toBe(true);
    expect(groups.has('ag1')).toBe(true);
  });

  it('repairFindings(ids)：只修用户选中的发现，未选中的保持', async () => {
    const gRid = 'P'.repeat(22);
    const cRid = 'Q'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gRid, { type: 'authenticatorGroup', localId: 'ag1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const groups = new Map([['ag1', { id: 'ag1', name: '亿贝安' }]]);
    const store = relinkStore(
      { id: 'c-1', name: '本地改过的名', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '5',
        records: [
          sealAlive(gRid, '1', '5', { type: 'authenticatorGroup', name: '天九-数科', sortOrder: 0 }),
          sealAlive(cRid, '1', '6', { type: 'connection', name: 'c', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: 'G'.repeat(22) }),
        ],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store, authenticatorBackend: authGroupBackend(groups) } as never);

    // 只修验证器分组名这一条。
    const r = await eng.repairFindings([`nameDrift:authenticatorGroup:ag1`]);
    expect(r.cloud).toBe(1);
    expect(r.cloud).toBe(1);
    expect(groups.get('ag1')?.name).toBe('天九-数科');
    // 未选中的连接名漂移保持原样。
    expect((store.get('c-1') as unknown as { name?: string } | undefined)?.name).toBe('本地改过的名');
    // 剩余发现仍可后续修复。
    const rest = await eng.inspectFindings();
    expect(rest.findings).toEqual([
      { id: 'nameDrift:connection:c-1', kind: 'nameDrift', type: 'connection', recordId: cRid, localId: 'c-1', localValue: '本地改过的名', remoteValue: 'c' },
    ]);
  });

  it('连接名漂移：repair 按云端校准（命名比对不限分组类型）', async () => {
    const cRid = 'Q'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: '本地改过的名', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(cRid, '1', '5', { type: 'connection', name: 'c', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: 'G'.repeat(22) })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([
      { id: 'nameDrift:connection:c-1', kind: 'nameDrift', type: 'connection', recordId: cRid, localId: 'c-1', localValue: '本地改过的名', remoteValue: 'c' },
    ]);
    const r = await eng.repairFindings();
    expect(r.cloud).toBe(1);
    expect((store.get('c-1') as unknown as { name?: string } | undefined)?.name).toBe('c');
  });

  it('本地方向（用本机覆盖云端）：命名漂移 → 出站 put（版本=云端+1），不改本地、不直发', async () => {
    const cRid = 'R'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: '本地名', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(cRid, '1', '5', { type: 'connection', name: '云端名', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: 'G'.repeat(22) })] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store } as never);

    const r = await eng.repairFindings([`nameDrift:connection:c-1`], 'local');
    expect(r.pending).toBe(0);
    expect(r.local).toBe(1); // 定向推送：只发本条
    expect(r.cloud).toBe(0); // 使用本机不改本机数据
    // 定向推送走签名出站（与常规推送同链路），推完确认并清出出站。
    expect(client.putRecordSigned).toHaveBeenCalledTimes(1);
    expect(outbox.list()).toHaveLength(0);
    // 本机保持原样（使用本机 = 推内容上云，不改本机）；未走未签名通道。
    expect((store.get('c-1') as unknown as { name?: string } | undefined)?.name).toBe('本地名');
    expect(client.putRecord).not.toHaveBeenCalled();
  });

  it('本地方向：本机已删云端仍在 → 出站 delete 并定向推送（保持删除意图）', async () => {
    const id = 'S'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const store = makeStore([
      { id: 'c-lost', name: 'gone', dbType: 'MYSQL', host: 'h', port: 3306, deleted: true, updateTime: 999999 } as unknown as SavedConnection,
    ]);
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [aliveConnectionRecord(id, '3', '5')] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store });

    const r = await eng.repairFindings([`orphanDelete:connection:c-lost`], 'local');
    expect(r.pending).toBe(0);
    expect(r.local).toBe(1);
    expect(client.deleteRecordSigned).toHaveBeenCalledTimes(1);
    expect(outbox.list()).toHaveLength(0); // 推送确认后清出
    expect((store.get('c-lost') as unknown as { deleted?: boolean } | undefined)?.deleted).toBe(true);
  });

  it('定向推送隔离：出站已有积压时，点选一条只推该条（积压不动，等显式同步）', async () => {
    const cRid = 'V'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: '本地名', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(cRid, '1', '5', { type: 'connection', name: '云端名', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: 'G'.repeat(22) })] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    // 出站先有一条无关积压（历史遗留，未被用户点选）。
    const stale = { ...putMutation(), recordId: 'W'.repeat(22), localId: 'c-stale' };
    await outbox.put(stale);
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store } as never);

    const r = await eng.repairFindings([`nameDrift:connection:c-1`], 'local');
    expect(r.local).toBe(1);
    // 只发用户点选的那条；积压原样留在出站（不会被顺手冲出去）。
    expect(client.putRecordSigned).toHaveBeenCalledTimes(1);
    const rest = outbox.list();
    expect(rest).toHaveLength(1);
    expect(rest[0].mutationId).toBe(stale.mutationId);
  });

  it('合并方向：字段级并集（本机字段优先）落地本地 + 定向推送', async () => {
    const cRid = 'X'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put('G'.repeat(22), { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: '本地名', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(cRid, '1', '5', { type: 'connection', name: '云端名', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: 'G'.repeat(22) })] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store } as never);

    const r = await eng.repairFindings([`nameDrift:connection:c-1`], 'merge');
    expect(r.merged).toBe(1);
    expect(r.local).toBe(1);
    // 合并语义（与冲突解决一致）：远端为基、本机字段覆盖 → 名字取本机。
    expect((store.get('c-1') as unknown as { name?: string } | undefined)?.name).toBe('本地名');
    expect(client.putRecordSigned).toHaveBeenCalledTimes(1);
    expect(outbox.list()).toHaveLength(0);
  });

  it('合并方向退化：云端已删 → 按云端收敛（应用墓碑，不入出站）', async () => {
    const id = 'Y'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-0', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    // 协议：墓碑记录不得携带 nonce/ciphertext/tag（parsePage 严格校验）。
    const deadRecord = { recordId: id, version: '2', changeSequence: '5', deleteTime: '2026-10-14T00:00:00.000Z' };
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [deadRecord] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store } as never);

    const r = await eng.repairFindings([`remoteDeleted:group:g1`], 'merge');
    expect(r.cloud).toBe(1); // 云端已删 → 合并退化为按云端收敛
    expect(r.pending).toBe(0);
    expect(r.local).toBe(0);
    expect(outbox.list()).toHaveLength(0);
  });

  it('本地方向：missing 使用本机=删除云端这条（定向推送，S7k.12 语义）', async () => {
    const id = 'A'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(id, { type: 'connection', localId: 'c-lost', recordVersion: '1', revision: 0, status: 'confirmed' });
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [aliveConnectionRecord(id, '1', '5')] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store: makeStore() });

    const r = await eng.repairFindings([`missing:connection:c-lost`], 'local');
    expect(r.local).toBe(1); // 本机侧为空 → 云端删除该记录
    expect(r.pending).toBe(0);
    expect(client.deleteRecordSigned).toHaveBeenCalledTimes(1);
    expect(outbox.list()).toHaveLength(0);
  });

  it('归属漂移的目标分组本机缺失（pending 映射被 classify 静默跳过）：兜底产出缺失发现并补云端名；按云端修复先恢复分组再归位', async () => {
    const cRid = 'T'.repeat(22);
    const gRid = 'U'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    // 目标分组映射 pending + 本机实体缺失：classify 不产动作（旧盲区），由 refDrift 目标兜底。
    await mapStore.put(gRid, { type: 'group', localId: 'g-x', recordVersion: '1', revision: 0, status: 'pending' });
    const conns = new Map<string, SavedConnection>([
      ['c-1', { id: 'c-1', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection],
    ]);
    const gs = new Map<string, { id: string; name: string; deleted?: boolean; updateTime?: number }>([['g1', { id: 'g1', name: 'G1' }]]);
    const store = {
      get: (id: string) => conns.get(id),
      save: async (c: SavedConnection) => { conns.set(c.id, { ...c, updateTime: (c as { updateTime?: number }).updateTime ?? Date.now() }); },
      remove: async (id: string) => { const c = conns.get(id); if (c) conns.set(id, { ...c, deleted: true }); },
      listForSync: () => [...conns.values()],
      listGroupsForSync: () => [...gs.values()].map((g) => ({ ...g, deleted: !!g.deleted, updateTime: g.updateTime ?? 1 })),
      listFoldersForSync: () => [],
      listQueriesForSync: () => [],
      getGroupById: (id: string) => gs.get(id),
      getFolderById: () => undefined,
      getQueryById: () => undefined,
      upsertGroup: async (g: { id: string; name: string }) => {
        const e = gs.get(g.id);
        if (e) { e.name = g.name; e.updateTime = Date.now(); }
        else { gs.set(g.id, { id: g.id, name: g.name, deleted: false, updateTime: Date.now() }); }
      },
      upsertFolder: async () => {},
      upsertQuery: async () => {},
      removeGroup: async () => {},
      removeQueryFolder: async () => {},
      removeQuery: async () => {},
    } as unknown as ConnectionStore;
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '6' })),
      getRecords: vi.fn(async () => ({
        snapshotSequence: '6',
        records: [
          sealAlive(cRid, '1', '5', { type: 'connection', name: 'c', dbType: 'mysql', host: 'h', port: 3306, user: 'u', groupId: gRid }),
          sealAlive(gRid, '2', '6', { type: 'group', name: 'G-cloud' }),
        ],
      })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([
      {
        id: 'refDrift:connection:c-1', kind: 'refDrift', type: 'connection', recordId: cRid, localId: 'c-1',
        localValue: 'c', ref: { field: 'groupId', local: 'G1', remote: undefined, remoteMissing: true },
      },
      {
        id: 'missing:group:g-x', kind: 'missing', type: 'group', recordId: gRid, localId: 'g-x',
        remoteValue: 'G-cloud',
      },
    ]);

    const r = await eng.repairFindings();
    expect(r.cloud).toBe(2); // 恢复缺失分组（pending 映射 force 确认）+ 条目按云端归位
    const newGroup = (store.get('c-1') as unknown as { groupId?: string } | undefined)?.groupId;
    expect(newGroup).toBeTruthy(); // 材料化 mint 新 localId 并重指映射（applyActive 既有行为）
    expect((store.getGroupById(newGroup!) as unknown as { name?: string } | undefined)?.name).toBe('G-cloud');
    expect((store.get('c-1') as unknown as { groupId?: string } | undefined)?.groupId).toBe(newGroup);
    const after = await eng.inspectFindings();
    expect(after.findings).toEqual([]);
  });
  it('云端独有记录（无本地映射）：全量对账产出 missing（带云端名）；使用本机=删除云端这条', async () => {
    const gRid = 'Z'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1'); // 无任何映射
    const store = relinkStore(
      { id: 'c-0', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', updateTime: 1 } as unknown as SavedConnection,
      [], // 本机没有任何分组
    );
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(gRid, '1', '5', { type: 'authenticatorGroup', name: '云端孤儿组', sortOrder: 0 })] })),
    });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const eng = engine({ client, snap: SNAP, mapStore, outbox, store, authenticatorBackend: authGroupBackend(new Map()) } as never);

    // 全量对账：无映射的云端存活记录 → 「云端有，本机没有」。
    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([
      { id: `missing:authenticatorGroup:${gRid}`, kind: 'missing', type: 'authenticatorGroup', recordId: gRid, localId: '', remoteValue: '云端孤儿组' },
    ]);

    // 使用本机（本机侧为空）→ 构建云端删除并定向推送（确认后清出出站）。
    const r = await eng.repairFindings([`missing:authenticatorGroup:${gRid}`], 'local');
    expect(r.local).toBe(1);
    expect(r.pending).toBe(0);
    expect(client.deleteRecordSigned).toHaveBeenCalledTimes(1);
    expect(outbox.list()).toHaveLength(0);
  });

  it('云端独有记录：使用云端=恢复到本机（mint 新实体+映射）', async () => {
    const gRid = 'a'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const groups = new Map<string, { id: string; name: string; sortOrder?: number; deleted?: boolean; updateTime?: number }>();
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(gRid, '1', '5', { type: 'authenticatorGroup', name: '云端组', sortOrder: 0 })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store: relinkStore({ id: 'c-0', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', updateTime: 1 } as unknown as SavedConnection, []), authenticatorBackend: authGroupBackend(groups) } as never);

    const r = await eng.repairFindings([`missing:authenticatorGroup:${gRid}`], 'cloud');
    expect(r.cloud).toBe(1);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]?.name).toBe('云端组');
    const after = await eng.inspectFindings();
    expect(after.findings).toEqual([]);
  });

  it('反向引用漂移：本机有分组、云端无 → 也算不一致（对称比较）', async () => {
    const cRid = 'b'.repeat(22);
    const gRid = 'c'.repeat(22);
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    await mapStore.put(gRid, { type: 'group', localId: 'g1', recordVersion: '1', revision: 1, status: 'confirmed' });
    await mapStore.put(cRid, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const store = relinkStore(
      { id: 'c-1', name: 'c', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', groupId: 'g1', updateTime: 1 } as unknown as SavedConnection,
      [{ id: 'g1', name: 'G1' }],
    );
    // 云端 payload 无 groupId（被覆盖丢失归属）——本机有 → 漂移。
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [sealAlive(cRid, '1', '5', { type: 'connection', name: 'c', dbType: 'mysql', host: 'h', port: 3306, user: 'u' })] })),
    });
    const eng = engine({ client, snap: SNAP, mapStore, outbox: new PendingMutationStore(makeMemento(), '7', '1'), store } as never);

    const v = await eng.inspectFindings();
    expect(v.findings).toEqual([
      { id: `refDrift:connection:c-1`, kind: 'refDrift', type: 'connection', recordId: cRid, localId: 'c-1', localValue: 'c', ref: { field: 'groupId', local: 'G1', remote: undefined } },
    ]);
  });
});

describe('SyncEngine · 选择性同步（类型停用，按机器）', () => {
  const u8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

  function mysqlRecord(recordId: string) {
    const payload = { type: 'connection', name: 'parked', dbType: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' };
    const nonce = new Uint8Array(12).fill(7);
    const box = sealRecord(
      new Uint8Array(32),
      nonce,
      new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8')),
      { userId: '7', keyEpoch: '1', recordId, recordVersion: '1' },
    );
    return {
      recordId, version: '1', changeSequence: '5', deleteTime: null,
      cipherSuite: 'AES-256-GCM', formatVersion: 1,
      nonce: u8(nonce), ciphertext: u8(box.ciphertext), tag: u8(box.tag),
    };
  }

  const NO_CONNECTIONS = (type: SyncEntityType) => type !== 'connection';

  it('停用类型：入站入 deferred 不落地（skippedDisabled 计数）；重开后 drain 落地', async () => {
    const store = makeStore();
    const memento = makeMemento();
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const unresolved = new UnresolvedRefStore(memento, '7', '1');
    const deferred = new DeferredRecordStore(memento, '7', '1');
    const dek = () => new Uint8Array(32);
    const rec = mysqlRecord('C'.repeat(22));

    const build = (client: PersonalSyncClient, typeEnabled?: (type: SyncEntityType) => boolean) => {
      const ents = new EntityStore(store, undefined, undefined, undefined, typeEnabled);
      return new SyncEngine({
        userId: '7', keyEpoch: '1', client,
        stateStore: makeStateStore(SNAP) as never,
        mapStore, outbox, entities: ents, unresolved, deferred,
        dek, signSeed: () => new Uint8Array(32), uniqueId: () => 'c-new-1',
        typeEnabled,
        seedConflictCarrier: seedConflictStub,
      });
    };

    const client1 = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
    });
    const r1 = await build(client1, NO_CONNECTIONS).sync();
    expect(r1.stage).toBe('ok');
    expect(r1.skippedDisabled).toBe(1);
    expect(deferred.list()).toHaveLength(1);
    expect(store.listForSync().filter((c) => !(c as unknown as { deleted?: boolean }).deleted)).toHaveLength(0);

    const client2 = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [] })),
    });
    const r2 = await build(client2, undefined).sync();
    expect(r2.stage).toBe('ok');
    expect(deferred.list()).toHaveLength(0);
    const conns = store.listForSync().filter((c) => !(c as unknown as { deleted?: boolean }).deleted);
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe('parked');
  });

  it('出站：停用类型不生成 mutation（EntityStore.listForSync 过滤）', async () => {
    const seed = { id: 'c-1', name: 'local', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', password: 'p', updateTime: 100 } as unknown as import('@devbelt/db-host/connection/connectionStore').SavedConnection;
    const store = makeStore([seed]);
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');

    const off = new SyncMutator({
      userId: '7', keyEpoch: '1', entities: new EntityStore(store, undefined, undefined, undefined, NO_CONNECTIONS),
      mapStore, outbox, dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32),
    });
    expect((await off.reconcile()).generated).toBe(0);
    expect(outbox.list()).toHaveLength(0);

    const on = new SyncMutator({
      userId: '7', keyEpoch: '1', entities: new EntityStore(store),
      mapStore, outbox, dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32),
    });
    expect((await on.reconcile()).generated).toBe(1);
  });

  it('体检：停用类型不产生 missing 发现（否则误报「本地缺少云端记录」）', async () => {
    const rec = mysqlRecord('D'.repeat(22));
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
    });
    const disabled = engine({
      client, snap: SNAP,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      typeEnabled: NO_CONNECTIONS,
    });
    expect((await disabled.inspectFindings()).findings).toEqual([]);

    const enabled = engine({
      client, snap: SNAP,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
    });
    const findings = (await enabled.inspectFindings()).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing', type: 'connection' });
  });
});

/** 构造一条用测试 DEK 加密的远端 put 记录；payload 可任意（含未来才有的实体类型）。 */
function sealedRemote(recordId: string, payload: Record<string, unknown>, changeSequence = '5') {
  const dek = new Uint8Array(32);
  const nonce = new Uint8Array(12).fill(3);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const box = sealRecord(dek, nonce, plaintext, { userId: '7', keyEpoch: '1', recordId, recordVersion: '1' });
  return {
    recordId, version: '1', changeSequence, deleteTime: null, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    nonce: Buffer.from(nonce).toString('base64url'),
    ciphertext: Buffer.from(box.ciphertext).toString('base64url'),
    tag: Buffer.from(box.tag).toString('base64url'),
  };
}

describe('SyncEngine · 配额超限不冻结入站', () => {
  it('SYNC_QUOTA_EXCEEDED：被拒条目留在 outbox，仍然 pull 入站，最终以 terminal 收尾', async () => {
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const m = putMutation();
    await outbox.put(m);
    const getRecords = vi.fn(async () => ({ snapshotSequence: '5', records: [] }));
    const client = clientWith({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords,
      putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_QUOTA_EXCEEDED'); }),
    });
    const rejected: Array<{ type: string; localId: string }> = [];
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox, onQuotaRejected: (ref) => { rejected.push(ref); } });

    const r = await eng.sync();

    expect(getRecords).toHaveBeenCalled();
    expect(r.stage).toBe('terminal');
    expect(r.terminal).toMatchObject({ mutationId: m.mutationId, code: 'SYNC_QUOTA_EXCEEDED' });
    expect(r.reason).toContain('quota');
    expect(rejected).toEqual([{ type: 'connection', localId: 'c-1' }]);
    expect(outbox.list()).toHaveLength(1);
  });

  it('配额超限的同时，入站新记录真的落地（以前整个入站被冻结）', async () => {
    const store = makeStore();
    const entities = new EntityStore(store);
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const rec = sealedRemote('R'.repeat(22), { type: 'connection', name: 'from-cloud', dbType: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1',
      client: clientWith({
        getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
        getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
        putRecordSigned: vi.fn(async () => { throw new SyncApiError(409, 'SYNC_QUOTA_EXCEEDED'); }),
      }),
      stateStore: makeStateStore(SNAP) as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox, entities,
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-cloud-1',
      seedConflictCarrier: seedConflictStub,
    });

    const r = await eng.sync();

    expect(r.stage).toBe('terminal');
    expect(r.terminal?.code).toBe('SYNC_QUOTA_EXCEEDED');
    expect(r.changes).toBe(1);
    const names = store.listForSync().map((c) => (c as unknown as { name?: string }).name);
    expect(names).toContain('from-cloud');
  });

  it('非配额的终态（签名无效）仍立即返回，不进入 pull', async () => {
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const getRecords = vi.fn(async () => ({ snapshotSequence: '0', records: [] }));
    const client = clientWith({
      getRecords,
      putRecordSigned: vi.fn(async () => { throw new SyncApiError(403, 'SYNC_SIGNATURE_INVALID'); }),
    });
    const eng = engine({ client, snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
    expect(r.terminal?.code).toBe('SYNC_SIGNATURE_INVALID');
    expect(getRecords).not.toHaveBeenCalled();
  });
});

describe('SyncEngine · 未知实体类型前向兼容', () => {
  function build(rec: ReturnType<typeof sealedRemote>, snap = SNAP) {
    const memento = makeMemento();
    const deferred = new DeferredRecordStore(memento, '7', '1');
    const setSnapshot = vi.fn(async () => undefined);
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1',
      client: clientWith({
        getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
        getRecords: vi.fn(async () => ({ snapshotSequence: '5', records: [rec] })),
      }),
      stateStore: { getSnapshot: () => snap, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(memento, '7', '1'),
      deferred,
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-x',
      seedConflictCarrier: seedConflictStub,
    });
    return { eng, deferred, setSnapshot };
  }

  it('未来才有的实体类型：入 deferred、计 skippedUnsupported、游标前进（不再无限重试卡死）', async () => {
    const rec = sealedRemote('Z'.repeat(22), { type: 'dashboardLayout', name: 'future' });
    const { eng, deferred, setSnapshot } = build(rec);

    const r = await eng.sync();

    expect(r.stage).toBe('ok');
    expect(r.skippedUnsupported).toBe(1);
    expect(deferred.list()).toHaveLength(1);
    expect(setSnapshot).toHaveBeenCalledWith({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' });
  });

  it('下一轮 drain 遇到仍不认识的类型：保留条目，不丢也不报错', async () => {
    const rec = sealedRemote('Z'.repeat(22), { type: 'dashboardLayout', name: 'future' });
    const { eng, deferred } = build(rec);
    await eng.sync();
    const r2 = await eng.sync();
    expect(r2.stage).toBe('ok');
    expect(deferred.list()).toHaveLength(1);
  });

  it('payload 缺 type（真正的协议违规）仍然是 error，不被当成未知类型吞掉', async () => {
    const rec = sealedRemote('Z'.repeat(22), { name: 'no-type' });
    const { eng, deferred } = build(rec);
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('apply failed');
    expect(deferred.list()).toHaveLength(0);
  });
});

describe('SyncEngine · 体检在检查失败时不报「一致」', () => {
  // null = 本地没有快照（用 undefined 会触发参数默认值而误取 SNAP）。
  function build(over: Partial<PersonalSyncClient>, snap: SyncStateSnapshot | null = SNAP) {
    return new SyncEngine({
      userId: '7', keyEpoch: '1',
      client: clientWith(over),
      stateStore: { getSnapshot: () => snap ?? undefined, setSnapshot: vi.fn() } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(makeStore()),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => 'c-x',
      seedConflictCarrier: seedConflictStub,
    });
  }

  it('getState 失败（断网）→ incomplete + error，而不是空且完整', async () => {
    const eng = build({ getState: vi.fn(async () => { throw new Error('fetch failed'); }) });
    const r = await eng.inspectFindings();
    expect(r.incomplete).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.error).toContain('getState failed');
    expect(r.error).toContain('fetch failed');
  });

  it('远端 epoch 不一致 → incomplete + error', async () => {
    const eng = build({ getState: vi.fn(async () => stateDto({ keyEpoch: '2', stateVersion: '1', changeSequence: '1' })) });
    const r = await eng.inspectFindings();
    expect(r.incomplete).toBe(true);
    expect(r.error).toContain('keyEpoch');
  });

  it('本地没有同步快照 → incomplete + error', async () => {
    const eng = build({}, null);
    const r = await eng.inspectFindings();
    expect(r.incomplete).toBe(true);
    expect(r.error).toContain('no local sync state');
  });

  it('检查正常且无差异 → incomplete=false 且无 error（仍能报「一致」）', async () => {
    const eng = build({});
    const r = await eng.inspectFindings();
    expect(r.incomplete).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('repairFindings：getState 失败 → aborted 原因，而不是全零「修复了 0 条」', async () => {
    const eng = build({ getState: vi.fn(async () => { throw new Error('fetch failed'); }) });
    const r = await eng.repairFindings();
    expect(r.aborted).toContain('getState failed');
    expect(r.cloud + r.local + r.merged + r.swept + r.failed).toBe(0);
  });

  it('repairFindings：epoch 不一致 → aborted', async () => {
    const eng = build({ getState: vi.fn(async () => stateDto({ keyEpoch: '9', stateVersion: '1', changeSequence: '1' })) });
    const r = await eng.repairFindings();
    expect(r.aborted).toContain('keyEpoch');
  });
});

describe('SyncEngine · 取消（epoch 切换停在途轮次）', () => {
  function build(over: Partial<PersonalSyncClient>, store = makeStore()) {
    const setSnapshot = vi.fn(async () => undefined);
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1',
      client: clientWith(over),
      stateStore: { getSnapshot: () => SNAP, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      entities: new EntityStore(store),
      unresolved: new UnresolvedRefStore(makeMemento(), '7', '1'),
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueId: () => `c-${Math.random()}`,
      seedConflictCarrier: seedConflictStub,
    });
    return { eng, setSnapshot, store };
  }

  it('已取消的引擎：开跑后在第一个检查点返回固定 reason，不拉 feed、不提交游标', async () => {
    const getRecords = vi.fn(async () => ({ snapshotSequence: '5', records: [] }));
    const { eng, setSnapshot } = build({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords,
    });
    eng.cancel();
    const r = await eng.sync();
    expect(r.reason).toBe(SYNC_CANCELLED_REASON);
    expect(getRecords).not.toHaveBeenCalled();
    expect(setSnapshot).not.toHaveBeenCalled();
  });

  it('翻页中途取消：已提交的页保留，之后的页不再请求也不再应用', async () => {
    const store = makeStore();
    const rec1 = sealedRemote('P'.repeat(22), { type: 'connection', name: 'page-1', dbType: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' }, '1');
    const rec2 = sealedRemote('Q'.repeat(22), { type: 'connection', name: 'page-2', dbType: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' }, '2');
    let eng!: SyncEngine;
    const getRecords = vi.fn()
      .mockImplementationOnce(async () => { return { snapshotSequence: '2', nextAfter: '1', records: [rec1] }; })
      .mockImplementation(async () => ({ snapshotSequence: '2', records: [rec2] }));
    const built = build({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '2' })),
      getRecords,
    }, store);
    eng = built.eng;
    // 第一页提交游标后立刻取消（模拟 destroy/reset 在两页之间到达）
    built.setSnapshot.mockImplementationOnce(async () => { eng.cancel(); });

    const r = await eng.sync();

    expect(r.reason).toBe(SYNC_CANCELLED_REASON);
    expect(getRecords).toHaveBeenCalledTimes(1);
    const names = store.listForSync().map((c) => (c as unknown as { name?: string }).name);
    expect(names).toContain('page-1');
    expect(names).not.toContain('page-2');
  });

  it('页内取消：未处理的记录不应用', async () => {
    const store = makeStore();
    const rec1 = sealedRemote('P'.repeat(22), { type: 'connection', name: 'first', dbType: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' }, '1');
    const rec2 = sealedRemote('Q'.repeat(22), { type: 'connection', name: 'second', dbType: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' }, '2');
    const { eng } = build({
      getState: vi.fn(async () => stateDto({ keyEpoch: '1', stateVersion: '1', changeSequence: '2' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '2', records: [rec1, rec2] })),
    }, store);
    // 第一条应用后取消：用 save 钩子在首次落盘后触发
    const originalSave = (store as unknown as { save: (c: unknown) => Promise<void> }).save;
    (store as unknown as { save: (c: unknown) => Promise<void> }).save = async (c) => { await originalSave(c); eng.cancel(); };

    const r = await eng.sync();

    expect(r.reason).toBe(SYNC_CANCELLED_REASON);
    const names = store.listForSync().map((c) => (c as unknown as { name?: string }).name);
    expect(names).toEqual(['first']);
  });

  it('resume() 之后恢复正常同步', async () => {
    const { eng } = build({});
    eng.cancel();
    expect((await eng.sync()).reason).toBe(SYNC_CANCELLED_REASON);
    eng.resume();
    expect((await eng.sync()).stage).toBe('ok');
  });

  it('出站循环里取消：不再推送后面的 mutation', async () => {
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    await outbox.put(putMutation());
    const putRecordSigned = vi.fn(async () => ({ version: '1', changeSequence: '1' }));
    const eng = engine({ client: clientWith({ putRecordSigned }), snap: SNAP, mapStore: new RecordMapStore(makeMemento(), '7', '1'), outbox });
    eng.cancel();
    const r = await eng.sync();
    expect(r.reason).toBe(SYNC_CANCELLED_REASON);
    expect(putRecordSigned).not.toHaveBeenCalled();
    expect(outbox.list()).toHaveLength(1);
  });
});
