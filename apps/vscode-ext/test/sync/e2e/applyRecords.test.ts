import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devkit/db-core';
import { applyRecord, reconcileUnresolved, assertSafeGroupParent } from '@devkit/db-host/sync/e2e/applyRecords';
import { RecordMapStore } from '@devkit/db-host/sync/e2e/recordMapStore';
import { EntityStore, UnresolvedRefStore } from '@devkit/db-host/sync/e2e/entityStore';
import { RecordConflictError } from '@devkit/db-host/sync/e2e/errors';
import type { SavedConnection, ConnectionGroup, ConnectionStore } from '@devkit/db-host/connection/connectionStore';
import type { QueryFolder } from '@devkit/db-host/connection/queryStore';
import type { SavedQuery } from '@devkit/db-core';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

/** 内存化 ConnectionStore，覆盖 EntityStore 所需的读写面。 */
function makeConnectionStore() {
  const connections = new Map<string, SavedConnection>();
  const groups = new Map<string, ConnectionGroup>();
  const folders = new Map<string, QueryFolder>();
  const queries = new Map<string, SavedQuery>();
  let clock = 1000;
  const tick = () => ++clock;

  const store = {
    listForSync: () => [...connections.values()],
    listGroupsForSync: () => [...groups.values()],
    listFoldersForSync: () => [...folders.values()],
    listQueriesForSync: () => [...queries.values()],
    get: (id: string) => connections.get(id),
    getGroupById: (id: string) => groups.get(id),
    getFolderById: (id: string) => folders.get(id),
    getQueryById: (id: string) => queries.get(id),
    save: async (c: SavedConnection) => {
      const prev = connections.get(c.id);
      connections.set(c.id, { ...prev, ...c, id: c.id, updateTime: tick(), createTime: prev?.createTime ?? tick() });
    },
    remove: async (id: string) => {
      const c = connections.get(id);
      if (c) connections.set(id, { ...c, deleted: true, updateTime: tick() });
    },
    upsertGroup: async (g: ConnectionGroup) => {
      const prev = groups.get(g.id);
      groups.set(g.id, { ...prev, ...g, id: g.id, updateTime: g.updateTime ?? tick(), createTime: prev?.createTime ?? g.createTime ?? tick() });
    },
    removeGroup: async (id: string) => {
      const g = groups.get(id);
      if (g) groups.set(id, { ...g, deleted: true, updateTime: tick() });
    },
    upsertFolder: async (f: QueryFolder) => {
      const prev = folders.get(f.id);
      folders.set(f.id, { ...prev, ...f, id: f.id, updateTime: f.updateTime ?? tick(), createTime: prev?.createTime ?? f.createTime ?? tick() });
    },
    removeQueryFolder: async (id: string) => {
      const f = folders.get(id);
      if (f) folders.set(id, { ...f, deleted: true, updateTime: tick() });
    },
    upsertQuery: async (q: SavedQuery) => {
      const prev = queries.get(q.id);
      queries.set(q.id, { ...prev, ...q, id: q.id, updateTime: q.updateTime ?? tick(), createTime: prev?.createTime ?? q.createTime ?? tick() });
    },
    removeQuery: async (id: string) => {
      const q = queries.get(id);
      if (q) queries.set(id, { ...q, deleted: true, updateTime: tick() });
    },
    // 级联：连接删除 tombstones 其查询与文件夹
    cascadeDeleteByConnection: async () => {},
  } as unknown as ConnectionStore;
  return { store, connections, groups, folders, queries };
}

function setup() {
  const { store, connections, groups, folders, queries } = makeConnectionStore();
  const mapStore = new RecordMapStore(makeMemento(), '7', '1');
  const unresolved = new UnresolvedRefStore(makeMemento(), '7', '1');
  const entities = new EntityStore(store);
  let counter = 0;
  const prefix: Record<string, string> = { connection: 'c', group: 'g', queryFolder: 'qf', query: 'q' };
  const uniqueId = (type: 'connection' | 'group' | 'queryFolder' | 'query') => `${prefix[type]}-${++counter}`;
  return { store, entities, mapStore, unresolved, uniqueId, connections, groups, folders, queries };
}

const connPayload = { type: 'connection', name: 'n', dbType: 'mysql', host: 'h', port: 3306, user: 'u', password: 'p' };

describe('applyRecord（连接）', () => {
  it('同 version 重放幂等：应用两次 → 恰好一个连接', async () => {
    const s = setup();
    const id = 'A'.repeat(22);
    expect(await applyRecord({ recordId: id, version: '1', tombstone: false, payload: connPayload }, s)).toMatchObject({ disposition: 'created' });
    expect(s.connections.size).toBe(1);
    expect(await applyRecord({ recordId: id, version: '1', tombstone: false, payload: connPayload }, s)).toMatchObject({ disposition: 'skipped' });
    expect(s.connections.size).toBe(1);
  });

  it('实体 save 未回报 updateTime 时抛错并回滚预留映射', async () => {
    const s = setup();
    const id = 'B'.repeat(22);
    // 模拟宿主 save 不回填 updateTime：守卫必须 fail（此前 `?? 0` 让该守卫成死代码）。
    (s.entities as any).get = () => ({ type: 'connection', localId: 'c-x', data: {} });
    await expect(
      applyRecord({ recordId: id, version: '1', tombstone: false, payload: connPayload }, s),
    ).rejects.toThrow(/did not report updateTime/);
    expect(s.mapStore.getByRecordId(id)).toBeUndefined();
  });

  it('更高 version 干净更新，连接数不变', async () => {
    const s = setup();
    const id = 'A'.repeat(22);
    await applyRecord({ recordId: id, version: '1', tombstone: false, payload: connPayload }, s);
    expect(await applyRecord({ recordId: id, version: '2', tombstone: false, payload: connPayload }, s)).toMatchObject({ disposition: 'updated' });
    expect(s.connections.size).toBe(1);
  });

  it('tombstone 删除已映射连接 + 清映射', async () => {
    const s = setup();
    const id = 'A'.repeat(22);
    await applyRecord({ recordId: id, version: '1', tombstone: false, payload: connPayload }, s);
    expect(await applyRecord({ recordId: id, version: '2', tombstone: true }, s)).toMatchObject({ disposition: 'deleted' });
    expect([...s.connections.values()].every((c) => c.deleted)).toBe(true);
    expect(s.mapStore.getByRecordId(id)).toBeUndefined();
  });

  it('未映射 tombstone 不建连接不报错', async () => {
    const s = setup();
    expect(await applyRecord({ recordId: 'A'.repeat(22), version: '1', tombstone: true }, s)).toMatchObject({ disposition: 'ignored-tombstone' });
    expect(s.connections.size).toBe(0);
  });

  it('本地脏 + 更高 version active → 冲突，保留本地连接', async () => {
    const s = setup();
    await s.entities.save({ type: 'connection', localId: 'c-1' }, { id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection, 'sync');
    await s.mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    await expect(applyRecord({ recordId: 'A'.repeat(22), version: '2', tombstone: false, payload: connPayload }, s)).rejects.toThrowError(RecordConflictError);
    expect(s.connections.size).toBe(1);
  });

  it('本地脏 + 更高 version tombstone → 冲突，不删', async () => {
    const s = setup();
    await s.entities.save({ type: 'connection', localId: 'c-1' }, { id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', updateTime: 200 } as SavedConnection, 'sync');
    await s.mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    await expect(applyRecord({ recordId: 'A'.repeat(22), version: '2', tombstone: true }, s)).rejects.toThrowError(RecordConflictError);
    expect(s.connections.size).toBe(1);
  });

  it('引擎门禁（free + postgresql）跳过', async () => {
    const s = setup();
    const ctx = { ...s, entitlement: { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 2, maxSavedConnections: 10, allowConnectionImport: false } };
    expect(await applyRecord({ recordId: 'A'.repeat(22), version: '1', tombstone: false, payload: { ...connPayload, dbType: 'postgresql' } }, ctx)).toMatchObject({ disposition: 'skipped' });
    expect(s.connections.size).toBe(0);
  });

  it('未知 payload 字段拒绝（严格解码）', async () => {
    const s = setup();
    await expect(applyRecord({ recordId: 'A'.repeat(22), version: '1', tombstone: false, payload: { ...connPayload, extra: 1 } }, s)).rejects.toThrowError(/unexpected/);
  });

  it('SQLite payload 应用时不要求 host/port（兜底空值）', async () => {
    const s = setup();
    const id = 'A'.repeat(22);
    expect(await applyRecord({ recordId: id, version: '1', tombstone: false, payload: { type: 'connection', dbType: 'sqlite', name: 'sq', password: 'p' } }, s)).toMatchObject({ disposition: 'created' });
    const saved = [...s.connections.values()][0];
    expect(saved).toMatchObject({ dbType: 'SQLITE', name: 'sq', host: '', port: 0, user: '' });
  });
});

describe('applyRecord（四类型 + 引用 + unresolved + 环检测）', () => {
  it('group → connection 引用正常解析（同批拓扑序）', async () => {
    const s = setup();
    const gid = 'G'.repeat(22);
    const cid = 'C'.repeat(22);
    await applyRecord({ recordId: gid, version: '1', tombstone: false, payload: { type: 'group', name: 'Root' } }, s);
    await applyRecord({ recordId: cid, version: '1', tombstone: false, payload: { ...connPayload, groupId: gid } }, s);
    const conn = [...s.connections.values()][0];
    const group = [...s.groups.values()][0];
    expect(conn.groupId).toBe(group.id);
  });

  it('引用未到达：保留 unresolved（不落根）', async () => {
    const s = setup();
    const cid = 'C'.repeat(22);
    await applyRecord({ recordId: cid, version: '1', tombstone: false, payload: { ...connPayload, groupId: 'MISSING'.repeat(4).slice(0, 22) } }, s);
    // 连接已建但 groupId 未解析；unresolved 队列有记录
    expect(s.connections.get('c-1')!.groupId).toBeUndefined();
    expect(s.unresolved.list().length).toBe(1);
  });

  it('后续父实体到达后 reconcile 收敛 unresolved', async () => {
    const s = setup();
    const targetRecordId = 'T'.repeat(22);
    await applyRecord({ recordId: 'C'.repeat(22), version: '1', tombstone: false, payload: { ...connPayload, groupId: targetRecordId } }, s);
    expect(s.unresolved.list().length).toBe(1);
    // 父分组随后到达
    await applyRecord({ recordId: targetRecordId, version: '1', tombstone: false, payload: { type: 'group', name: 'Parent' } }, s);
    const resolved = await reconcileUnresolved(s);
    expect(resolved).toBe(1);
    const conn = [...s.connections.values()][0];
    const group = [...s.groups.values()][0];
    expect(conn.groupId).toBe(group.id);
    expect(s.unresolved.list().length).toBe(0);
  });

  it('group parentId 自指 fail-closed（环检测）', async () => {
    const s = setup();
    const id = 'G'.repeat(22);
    // 先建父分组映射，再让子分组 parentId 指回自身 → 解码后解析 parentId 为本 id
    await applyRecord({ recordId: id, version: '1', tombstone: false, payload: { type: 'group', name: 'G' } }, s);
    // 让一个分组以自身为 parent：构造 parentId 指向自己的 recordId 并已确认映射为同一 g-*
    // 这里直接用 assertSafeGroupParent 单测环检测
    expect(() => assertSafeGroupParent([{ id: 'g-1', name: 'G', parentId: 'g-1' } as ConnectionGroup], 'g-1', 'g-1')).toThrowError(/cycle/);
  });

  it('query 应用时 connId/folderId 正常解析', async () => {
    const s = setup();
    const cid = 'C'.repeat(22);
    await applyRecord({ recordId: cid, version: '1', tombstone: false, payload: { ...connPayload } }, s);
    await applyRecord({ recordId: 'Q'.repeat(22), version: '1', tombstone: false, payload: { type: 'query', name: 'q', sql: 'SELECT 1', connId: cid } }, s);
    expect(s.queries.size).toBe(1);
    const conn = [...s.connections.values()][0];
    expect([...s.queries.values()][0].connId).toBe(conn.id);
  });
});

describe('reconcileUnresolved', () => {
  it('依赖方实体已删则清理悬空 unresolved', async () => {
    const s = setup();
    const targetRecordId = 'T'.repeat(22);
    await applyRecord({ recordId: 'C'.repeat(22), version: '1', tombstone: false, payload: { type: 'queryFolder', name: 'F', connId: targetRecordId } }, s);
    expect(s.unresolved.list().length).toBe(1);
    // 删除依赖方文件夹（实体从 store 中消失）
    const folder = [...s.folders.values()][0];
    s.folders.delete(folder.id);
    // 目标仍未到达，reconcile 应清理悬空引用
    await reconcileUnresolved(s);
    // 依赖方实体已不存在 → 清理悬空
    expect(s.unresolved.list().length).toBe(0);
  });
});