import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devkit/db-core';
import { EntityStore, UnresolvedRefStore } from '@devkit/db-host/sync/e2e/entityStore';
import type { SavedConnection, ConnectionGroup, ConnectionStore } from '@devkit/db-host/connection/connectionStore';
import type { QueryFolder } from '@devkit/db-host/connection/queryStore';
import type { SavedQuery } from '@devkit/db-core';
import { applyOrder } from '@devkit/db-host/sync/e2e/entityStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

describe('EntityStore', () => {
  it('listForSync 汇总四类实体（含墓碑）', () => {
    const cs = {
      listForSync: () => [{ id: 'c-1', deleted: true, updateTime: 5 } as SavedConnection],
      listGroupsForSync: () => [{ id: 'g-1', updateTime: 6 } as ConnectionGroup],
      listFoldersForSync: () => [{ id: 'qf-1', updateTime: 7 } as QueryFolder],
      listQueriesForSync: () => [{ id: 'q-1', updateTime: 8 } as SavedQuery],
    } as unknown as ConnectionStore;
    const store = new EntityStore(cs);
    const list = store.listForSync();
    expect(list).toHaveLength(4);
    expect(list.find((r) => r.ref.type === 'connection')!.deleted).toBe(true);
    expect(list.find((r) => r.ref.type === 'group')!.updateTime).toBe(6);
  });

  it('get 按类型分派', () => {
    const cs = {
      listForSync: () => [{ id: 'c-1', deleted: false, updateTime: 1 } as SavedConnection],
      get: (id: string) => (id === 'c-1' ? { id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL } as SavedConnection : undefined),
      getGroupById: (id: string) => (id === 'g-1' ? { id: 'g-1', name: 'G' } as ConnectionGroup : undefined),
      getFolderById: (id: string) => (id === 'qf-1' ? { id: 'qf-1', name: 'F' } as QueryFolder : undefined),
      getQueryById: (id: string) => (id === 'q-1' ? { id: 'q-1', name: 'Q' } as SavedQuery : undefined),
    } as unknown as ConnectionStore;
    const store = new EntityStore(cs);
    expect(store.get({ type: 'connection', localId: 'c-1' })).toBeDefined();
    expect(store.get({ type: 'group', localId: 'g-1' })).toBeDefined();
    expect(store.get({ type: 'queryFolder', localId: 'qf-1' })).toBeDefined();
    expect(store.get({ type: 'query', localId: 'q-1' })).toBeDefined();
    expect(store.get({ type: 'connection', localId: 'missing' })).toBeUndefined();
  });

  it('applyOrder 依赖方向：group < connection < queryFolder < query', () => {
    expect(applyOrder('group')).toBeLessThan(applyOrder('connection'));
    expect(applyOrder('connection')).toBeLessThan(applyOrder('queryFolder'));
    expect(applyOrder('queryFolder')).toBeLessThan(applyOrder('query'));
  });
});

describe('UnresolvedRefStore', () => {
  it('add/list/remove/clear 关键隔离', async () => {
    const s = new UnresolvedRefStore(makeMemento(), '7', '1');
    await s.add({ targetRecordId: 'R'.repeat(22), type: 'connection', localId: 'c-1', field: 'groupId' });
    await s.add({ targetRecordId: 'R'.repeat(22), type: 'query', localId: 'q-1', field: 'connId' });
    expect(s.listForTarget('R'.repeat(22))).toHaveLength(2);
    expect(s.list()).toHaveLength(2);
    await s.remove('R'.repeat(22));
    expect(s.list()).toHaveLength(0);
  });

  it('同 target 同依赖方同字段去重', async () => {
    const s = new UnresolvedRefStore(makeMemento(), '7', '1');
    await s.add({ targetRecordId: 'R'.repeat(22), type: 'connection', localId: 'c-1', field: 'groupId' });
    await s.add({ targetRecordId: 'R'.repeat(22), type: 'connection', localId: 'c-1', field: 'groupId' });
    expect(s.listForTarget('R'.repeat(22))).toHaveLength(1);
  });
});