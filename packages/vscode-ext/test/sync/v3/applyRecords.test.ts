import { describe, expect, it, vi } from 'vitest';
import { applyRecord } from '../../../src/sync/v3/applyRecords';
import { RecordMapStore } from '../../../src/sync/v3/recordMapStore';
import { V3RecordConflictError } from '../../../src/sync/v3/errors';
import type { SavedConnection } from '../../../src/connection/connectionStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function makeStore(seed: SavedConnection[] = []) {
  const conns = new Map<string, SavedConnection>(seed.map((c) => [c.id, c]));
  let clock = 1000;
  return {
    get: (id: string) => conns.get(id),
    save: vi.fn(async (c: SavedConnection) => {
      const existing = conns.get(c.id);
      conns.set(c.id, { ...existing, ...c, id: c.id, updateTime: ++clock, createTime: existing?.createTime ?? clock, deleted: false });
    }),
    remove: vi.fn(async (id: string) => {
      const c = conns.get(id);
      if (c) conns.set(id, { ...c, deleted: true, updateTime: ++clock });
    }),
    all: () => [...conns.values()].filter((c) => !c.deleted),
  };
}

function setup(seed: SavedConnection[] = []) {
  const store = makeStore(seed);
  const mapStore = new RecordMapStore(makeMemento(), '7', '1');
  let counter = 0;
  const uniqueConnectionId = () => `c-new-${++counter}`;
  return { store, mapStore, uniqueConnectionId };
}

const payload = { dbType: 'mysql', name: 'n', host: 'h', port: 3306, user: 'u', password: 'p' };

describe('applyRecord', () => {
  it('同 version 重放幂等：应用两次 → 恰好一个连接', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const id = 'A'.repeat(22);
    expect(applyRecord({ recordId: id, version: '1', tombstone: false, payload }, { store: store as any, mapStore, uniqueConnectionId })).toMatchObject({ disposition: 'created' });
    await store.save.mock.results[0].value;
    expect(store.all()).toHaveLength(1);
    expect(applyRecord({ recordId: id, version: '1', tombstone: false, payload }, { store: store as any, mapStore, uniqueConnectionId })).toMatchObject({ disposition: 'skipped' });
    expect(store.all()).toHaveLength(1);
  });

  it('更高 version 干净更新，连接数不变', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const id = 'A'.repeat(22);
    applyRecord({ recordId: id, version: '1', tombstone: false, payload }, { store: store as any, mapStore, uniqueConnectionId });
    expect(applyRecord({ recordId: id, version: '2', tombstone: false, payload }, { store: store as any, mapStore, uniqueConnectionId })).toMatchObject({ disposition: 'updated' });
    expect(store.all()).toHaveLength(1);
  });

  it('tombstone 删除已映射连接 + 清映射', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const id = 'A'.repeat(22);
    applyRecord({ recordId: id, version: '1', tombstone: false, payload }, { store: store as any, mapStore, uniqueConnectionId });
    expect(applyRecord({ recordId: id, version: '2', tombstone: true }, { store: store as any, mapStore, uniqueConnectionId })).toMatchObject({ disposition: 'deleted' });
    expect(store.all()).toHaveLength(0);
    expect(mapStore.getByRecordId(id)).toBeUndefined();
  });

  it('未映射 tombstone 不建连接不报错', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    expect(applyRecord({ recordId: 'A'.repeat(22), version: '1', tombstone: true }, { store: store as any, mapStore, uniqueConnectionId })).toMatchObject({ disposition: 'ignored-tombstone' });
    expect(store.all()).toHaveLength(0);
  });

  it('本地脏 + 更高 version → V3RecordConflictError', async () => {
    const dirtyConn: SavedConnection = { id: 'c-1', name: 'n', dbType: 'MYSQL' as any, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection;
    const { store, mapStore, uniqueConnectionId } = setup([dirtyConn]);
    mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 100 });
    expect(() => applyRecord(
      { recordId: 'A'.repeat(22), version: '2', tombstone: false, payload },
      { store: store as any, mapStore, uniqueConnectionId },
    )).toThrowError(V3RecordConflictError);
    expect(store.all()).toHaveLength(1); // 保留本地连接
  });

  it('引擎门禁（free + postgresql）跳过', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const free = { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 2 };
    const r = applyRecord(
      { recordId: 'A'.repeat(22), version: '1', tombstone: false, payload: { ...payload, dbType: 'postgresql' } },
      { store: store as any, mapStore, uniqueConnectionId, entitlement: free },
    );
    expect(r.disposition).toBe('skipped');
    expect(store.all()).toHaveLength(0);
  });
});