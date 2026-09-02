import { describe, expect, it, vi } from 'vitest';
import { applyRecord } from '../../../src/sync/e2e/applyRecords';
import { RecordMapStore } from '../../../src/sync/e2e/recordMapStore';
import { RecordConflictError } from '../../../src/sync/e2e/errors';
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
    const ctx = { store: store as any, mapStore, uniqueConnectionId };
    expect(await applyRecord({ recordId: id, version: '1', tombstone: false, payload }, ctx)).toMatchObject({ disposition: 'created' });
    expect(store.all()).toHaveLength(1);
    expect(await applyRecord({ recordId: id, version: '1', tombstone: false, payload }, ctx)).toMatchObject({ disposition: 'skipped' });
    expect(store.all()).toHaveLength(1);
  });

  it('更高 version 干净更新，连接数不变', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const id = 'A'.repeat(22);
    const ctx = { store: store as any, mapStore, uniqueConnectionId };
    await applyRecord({ recordId: id, version: '1', tombstone: false, payload }, ctx);
    expect(await applyRecord({ recordId: id, version: '2', tombstone: false, payload }, ctx)).toMatchObject({ disposition: 'updated' });
    expect(store.all()).toHaveLength(1);
  });

  it('tombstone 删除已映射连接 + 清映射', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const id = 'A'.repeat(22);
    const ctx = { store: store as any, mapStore, uniqueConnectionId };
    await applyRecord({ recordId: id, version: '1', tombstone: false, payload }, ctx);
    expect(await applyRecord({ recordId: id, version: '2', tombstone: true }, ctx)).toMatchObject({ disposition: 'deleted' });
    expect(store.all()).toHaveLength(0);
    expect(mapStore.getByRecordId(id)).toBeUndefined();
  });

  it('未映射 tombstone 不建连接不报错', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    expect(await applyRecord({ recordId: 'A'.repeat(22), version: '1', tombstone: true }, { store: store as any, mapStore, uniqueConnectionId })).toMatchObject({ disposition: 'ignored-tombstone' });
    expect(store.all()).toHaveLength(0);
  });

  it('本地脏 + 更高 version active → 冲突，保留本地连接', async () => {
    const dirtyConn: SavedConnection = { id: 'c-1', name: 'n', dbType: 'MYSQL' as any, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection;
    const { store, mapStore, uniqueConnectionId } = setup([dirtyConn]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '2', tombstone: false, payload },
      { store: store as any, mapStore, uniqueConnectionId },
    )).rejects.toThrowError(RecordConflictError);
    expect(store.all()).toHaveLength(1);
  });

  it('本地脏 + 更高 version tombstone → 冲突，不删', async () => {
    const dirtyConn: SavedConnection = { id: 'c-1', name: 'n', dbType: 'MYSQL' as any, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection;
    const { store, mapStore, uniqueConnectionId } = setup([dirtyConn]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '2', tombstone: true },
      { store: store as any, mapStore, uniqueConnectionId },
    )).rejects.toThrowError(RecordConflictError);
    expect(store.all()).toHaveLength(1);
  });

  it('引擎门禁（free + postgresql）跳过', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const free = { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 2 };
    expect(await applyRecord(
      { recordId: 'A'.repeat(22), version: '1', tombstone: false, payload: { ...payload, dbType: 'postgresql' } },
      { store: store as any, mapStore, uniqueConnectionId, entitlement: free },
    )).toMatchObject({ disposition: 'skipped' });
    expect(store.all()).toHaveLength(0);
  });

  it('未知 payload 字段拒绝（严格解码）', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '1', tombstone: false, payload: { ...payload, extra: 1 } },
      { store: store as any, mapStore, uniqueConnectionId },
    )).rejects.toThrowError(/unexpected/);
  });

  it('预留映射失败不写连接', async () => {
    const { store, uniqueConnectionId } = setup();
    const mapStore = {
      getByRecordId: () => undefined,
      put: vi.fn(async () => { throw new Error('map write failed'); }),
      deleteByRecordId: vi.fn(async () => {}),
    };
    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '1', tombstone: false, payload },
      { store: store as any, mapStore: mapStore as any, uniqueConnectionId },
    )).rejects.toThrowError(/map write failed/);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('更新映射持久化失败时恢复旧连接内容', async () => {
    const old = { id: 'c-1', name: 'old', dbType: 'MYSQL' as any, host: 'old-host', port: 3306, user: 'old-user', updateTime: 100 } as SavedConnection;
    const { store, mapStore, uniqueConnectionId } = setup([old]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    vi.spyOn(mapStore, 'put').mockRejectedValueOnce(new Error('map write failed'));

    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '2', tombstone: false, payload },
      { store: store as any, mapStore, uniqueConnectionId },
    )).rejects.toThrowError(/map write failed/);
    expect(store.get('c-1')).toMatchObject({ name: 'old', host: 'old-host', user: 'old-user' });
  });

  it('连接写失败回滚预留映射', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    store.save.mockRejectedValueOnce(new Error('store write failed'));
    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '1', tombstone: false, payload },
      { store: store as any, mapStore, uniqueConnectionId },
    )).rejects.toThrowError(/rollback succeeded/);
    expect(mapStore.getByRecordId('A'.repeat(22))).toBeUndefined();
  });

  it('save 失败且回滚失败：留下 pending 映射并抛聚合错误', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    store.save.mockRejectedValueOnce(new Error('store write failed'));
    vi.spyOn(mapStore, 'deleteByRecordId').mockRejectedValueOnce(new Error('rollback failed'));
    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '1', tombstone: false, payload },
      { store: store as any, mapStore, uniqueConnectionId },
    )).rejects.toThrowError(/pending mapping kept for recovery/);
    expect(mapStore.getByRecordId('A'.repeat(22))?.status).toBe('pending');
  });

  it('连接保存后回读不到 updateTime → 抛错并回滚映射', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    store.save.mockImplementationOnce(async () => {});
    await expect(applyRecord(
      { recordId: 'A'.repeat(22), version: '1', tombstone: false, payload },
      { store: store as any, mapStore, uniqueConnectionId },
    )).rejects.toThrowError(/did not report updateTime/);
    expect(mapStore.getByRecordId('A'.repeat(22))).toBeUndefined();
  });

  it('pending 预留重放自愈：收敛为单个已确认连接', async () => {
    const { store, mapStore, uniqueConnectionId } = setup();
    const id = 'A'.repeat(22);
    const ctx = { store: store as any, mapStore, uniqueConnectionId };
    await mapStore.put(id, { connectionId: 'c-ghost', recordVersion: '1', revision: 0, status: 'pending' });
    expect(await applyRecord({ recordId: id, version: '1', tombstone: false, payload }, ctx)).toMatchObject({ disposition: 'created' });
    const entry = mapStore.getByRecordId(id)!;
    expect(entry.status).toBe('confirmed');
    expect(entry.connectionId).not.toBe('c-ghost');
    expect(store.all()).toHaveLength(1);
  });
});
