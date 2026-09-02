import { describe, expect, it, vi } from 'vitest';
import { SyncEngine } from '../../../src/sync/e2e/syncEngine';
import { SyncApiError, type PersonalSyncClient } from '../../../src/sync/e2e/client';
import { RecordMapStore } from '../../../src/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingPutMutation } from '../../../src/sync/e2e/pendingMutationStore';
import type { SyncStateSnapshot } from '../../../src/sync/e2e/stateStore';
import type { SavedConnection } from '../../../src/connection/connectionStore';

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
  return {
    get: (id: string) => conns.get(id),
    save: vi.fn(async (c: SavedConnection) => { conns.set(c.id, { ...c, updateTime: Date.now() }); }),
    remove: vi.fn(async (id: string) => { const c = conns.get(id); if (c) conns.set(id, { ...c, deleted: true, updateTime: Date.now() }); }),
    all: () => [...conns.values()].filter((c) => !(c as unknown as { deleted?: boolean }).deleted),
  };
}

function clientWith(over: Partial<PersonalSyncClient> = {}) {
  return {
    getState: vi.fn(async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' })),
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
  return new SyncEngine({
    userId: '7',
    keyEpoch: '1',
    client: opts.client,
    stateStore: makeStateStore(opts.snap, opts.setImpl) as never,
    mapStore: opts.mapStore,
    outbox: opts.outbox,
    store: store as never,
    dek: () => new Uint8Array(32),
    signSeed: opts.signSeed ?? (() => new Uint8Array(32)),
    uniqueConnectionId: () => `c-new-${Math.random()}`,
  });
}

const SNAP: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '1', changeSequence: '0' };

function putMutation(): PendingPutMutation {
  return {
    action: 'record.put', recordId: 'A'.repeat(22), connectionId: 'c-1', baseVersion: '0',
    mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
    signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43),
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
    const client = clientWith({ getState: vi.fn(async () => ({ keyEpoch: '2', stateVersion: '1', changeSequence: '1' })) });
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
    await mapStore.put(id, { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'pending' });
    const store = makeStore([{ id: 'c-1', name: 'n', dbType: 'MYSQL' as never, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection]);
    const client = clientWith({
      getState: vi.fn(async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
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
      getState: vi.fn(async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '3' })),
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
      getState: vi.fn(async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
      getRecords,
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => SNAP, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      store: makeStore() as never,
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueConnectionId: () => 'c-new-1',
    });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('snapshotSequence drift');
    expect(setSnapshot).toHaveBeenCalledTimes(1);
    expect(setSnapshot).toHaveBeenCalledWith({ keyEpoch: '1', stateVersion: '1', changeSequence: '3' });
  });

  it('分页停滞（nextAfter 未前进）→ error', async () => {
    const client = clientWith({
      getState: vi.fn(async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '5' })),
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
      store: makeStore() as never,
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueConnectionId: () => 'c-new-1',
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
      getState: vi.fn(async () => ({ keyEpoch: '1', stateVersion: '2', changeSequence: '0' })),
      getRecords: vi.fn(async () => ({ snapshotSequence: '0', records: [] })),
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => SNAP, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      store: makeStore() as never,
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueConnectionId: () => 'c-new-1',
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
      getState: vi.fn(async () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' })),
      getRecords,
    });
    const eng = new SyncEngine({
      userId: '7', keyEpoch: '1', client,
      stateStore: { getSnapshot: () => localSnap, setSnapshot } as never,
      mapStore: new RecordMapStore(makeMemento(), '7', '1'),
      outbox: new PendingMutationStore(makeMemento(), '7', '1'),
      store: makeStore() as never,
      dek: () => new Uint8Array(32), signSeed: () => new Uint8Array(32), uniqueConnectionId: () => 'c-new-1',
    });
    const r = await eng.sync();
    expect(r.stage).toBe('error');
    expect(r.reason).toContain('behind local');
    expect(setSnapshot).not.toHaveBeenCalled();
    expect(getRecords).not.toHaveBeenCalled();
  });
});