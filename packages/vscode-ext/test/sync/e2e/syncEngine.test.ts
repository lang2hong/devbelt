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

function makeStateStore(snap?: SyncStateSnapshot) {
  return {
    getSnapshot: vi.fn(() => snap),
    setSnapshot: vi.fn(async (_s: SyncStateSnapshot) => {}),
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
    ...over,
  } as unknown as PersonalSyncClient;
}

function engine(client: PersonalSyncClient, snap: SyncStateSnapshot | undefined, mapStore: RecordMapStore, outbox: PendingMutationStore, store: ReturnType<typeof makeStore>) {
  return new SyncEngine({
    userId: '7',
    client,
    stateStore: makeStateStore(snap) as never,
    mapStore,
    outbox,
    store: store as never,
    dek: () => new Uint8Array(32),
    signSeed: () => new Uint8Array(32),
    uniqueConnectionId: () => `c-new-${Math.random()}`,
  });
}

const SNAP: SyncStateSnapshot = { keyEpoch: '1', stateVersion: '1', changeSequence: '0' };

describe('SyncEngine', () => {
  it('并发 sync() 单飞合并', async () => {
    const client = clientWith();
    const eng = engine(client, SNAP, new RecordMapStore(makeMemento(), '7', '1'), new PendingMutationStore(makeMemento(), '7', '1'), makeStore());
    const [a, b] = await Promise.all([eng.sync(), eng.sync()]);
    expect(client.getState).toHaveBeenCalledTimes(1);
    expect(a.stage).toBe('ok');
    expect(b.stage).toBe('ok');
  });

  it('远端 epoch 高于本地 → epoch-mismatch，不拉 feed', async () => {
    const client = clientWith({ getState: vi.fn(async () => ({ keyEpoch: '2', stateVersion: '1', changeSequence: '1' })) });
    const eng = engine(client, SNAP, new RecordMapStore(makeMemento(), '7', '1'), new PendingMutationStore(makeMemento(), '7', '1'), makeStore());
    const r = await eng.sync();
    expect(r.stage).toBe('epoch-mismatch');
    expect(client.getRecords).not.toHaveBeenCalled();
  });

  it('outbox 重放 409(4xx) → terminal，保留 outbox 项', async () => {
    const client = clientWith({ putRecord: vi.fn(async () => { throw new SyncApiError(409, 'CONFLICT'); }) });
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const m: PendingPutMutation = {
      action: 'record.put', recordId: 'A'.repeat(22), connectionId: 'c-1', baseVersion: '0',
      mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
      signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43),
    };
    await outbox.put(m);
    const eng = engine(client, SNAP, new RecordMapStore(makeMemento(), '7', '1'), outbox, makeStore());
    const r = await eng.sync();
    expect(r.stage).toBe('terminal');
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
    const eng = engine(client, SNAP, mapStore, new PendingMutationStore(makeMemento(), '7', '1'), store);
    const r = await eng.sync();
    expect(r.stage).toBe('conflict');
    expect(r.conflicts).toEqual([{ recordId: id, kind: 'pending' }]);
    expect(r.changeSequence).toBe('0');
  });
});