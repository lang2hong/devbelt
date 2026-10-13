import { describe, expect, it } from 'vitest';
import { applyRecord, reconcileUnresolved } from '@devbelt/db-host/sync/e2e/applyRecords';
import { RecordMapStore } from '@devbelt/db-host/sync/e2e/recordMapStore';
import { EntityStore, UnresolvedRefStore, type EntitySyncRecord } from '@devbelt/db-host/sync/e2e/entityStore';
import { encodeEntityPayload, decodeEntityPayload } from '@devbelt/db-host/sync/e2e/recordCodec';
import type { SyncEntityType } from '@devbelt/db-host/sync/e2e/syncEntity';
import type { SyncSchemaNotesValue } from '@devbelt/db-host/sync/e2e/schemaNotesTypes';
import type { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import { AiContextStore, SCHEMA_NOTES_PREFIX, SCHEMA_NOTES_RECORD_PREFIX } from '../../../src/ai/aiContextStore';
import { SchemaNotesSyncBackend } from '../../../src/ai/schemaNotesSyncBackend';

const RID = (ch: string) => ch.repeat(22);
const CONN_REC = RID('C');

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => {
      if (v === undefined) m.delete(k);
      else m.set(k, v);
    },
    keys: (): readonly string[] => [...m.keys()],
    data: m,
  };
}

const emptyPersonalStore = {
  listForSync: () => [], listGroupsForSync: () => [], listFoldersForSync: () => [], listQueriesForSync: () => [],
  get: () => undefined, getGroupById: () => undefined, getFolderById: () => undefined, getQueryById: () => undefined,
  save: async () => {}, remove: async () => {}, upsertGroup: async () => {}, removeGroup: async () => {},
  upsertFolder: async () => {}, removeQueryFolder: async () => {}, upsertQuery: async () => {}, removeQuery: async () => {},
} as unknown as ConnectionStore;

function setup() {
  const memento = makeMemento();
  const store = new AiContextStore(memento as never);
  const backend = new SchemaNotesSyncBackend(store);
  const entities = new EntityStore(emptyPersonalStore, undefined, backend);
  const mapStore = new RecordMapStore(makeMemento() as never, '7', '1');
  const unresolved = new UnresolvedRefStore(makeMemento() as never, '7', '1');
  let counter = 0;
  const prefix: Record<SyncEntityType, string> = {
    connection: 'c', group: 'g', queryFolder: 'qf', query: 'q',
    authenticatorEntry: 'ae', authenticatorGroup: 'ag', authenticatorTag: 'at',
    schemaNotes: 'sn',
  };
  const uniqueId = (type: SyncEntityType) => `${prefix[type]}-${++counter}`;
  return { memento, store, backend, entities, mapStore, unresolved, uniqueId };
}

describe('S7f codec：schemaNotes 实体', () => {
  const value: SyncSchemaNotesValue = {
    id: 'sn-1',
    connId: 'c-1',
    scope: 'app',
    tables: { orders: { note: '订单主表', columns: { id: { note: '主键', sample: '1, 2' } } } },
    updateTime: 0,
  };

  it('编码：connId 本地 id → recordId；tables 原样透传', () => {
    const payload = encodeEntityPayload({ type: 'schemaNotes', entity: value }, (type, localId) => (type === 'connection' && localId === 'c-1' ? CONN_REC : undefined));
    expect(payload).toMatchObject({ type: 'schemaNotes', connId: CONN_REC, scope: 'app' });
    expect(payload.tables).toEqual(value.tables);
  });

  it('编码：connId 未映射 → 省略字段（unresolved，后续轮收敛）', () => {
    const payload = encodeEntityPayload({ type: 'schemaNotes', entity: value }, () => undefined);
    expect('connId' in payload).toBe(false);
  });

  it('编码/解码 roundtrip；缺 connId 解码为 undefined', () => {
    const decoded = decodeEntityPayload({ type: 'schemaNotes', connId: CONN_REC, scope: 'app', tables: value.tables });
    expect(decoded).toEqual({ type: 'schemaNotes', data: { connId: CONN_REC, scope: 'app', tables: value.tables } });
    const noConn = decodeEntityPayload({ type: 'schemaNotes', scope: '', tables: {} });
    expect(noConn.type).toBe('schemaNotes');
    if (noConn.type === 'schemaNotes') expect(noConn.data.connId).toBeUndefined();
  });

  it('解码忽略多带字段（D14 向前兼容）；非法 tables 拒绝', () => {
    const decoded = decodeEntityPayload({ type: 'schemaNotes', scope: 'app', tables: {}, future: 1 });
    expect(decoded.type).toBe('schemaNotes');
    expect(() => decodeEntityPayload({ type: 'schemaNotes', scope: 'app', tables: [1] })).toThrowError(/tables/);
  });
});

describe('S7f apply：schemaNotes 实体（connId 引用/未决/墓碑）', () => {
  it('connId 已映射 → 应用为本地记录，store API 可读', async () => {
    const s = setup();
    await s.mapStore.put(CONN_REC, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const nRec = RID('N');
    const result = await applyRecord(
      { recordId: nRec, version: '1', tombstone: false, payload: { type: 'schemaNotes', connId: CONN_REC, scope: 'app', tables: { orders: { note: 'x' } } } },
      s,
    );
    expect(result.disposition).toBe('created');
    expect(s.store.getSchemaNotes('c-1', 'app').tables['orders']?.note).toBe('x');
    expect(s.mapStore.getByRecordId(nRec)?.type).toBe('schemaNotes');
  });

  it('connId 未映射 → unresolved；连接到达后 reconcile 收敛到本地 id', async () => {
    const s = setup();
    const nRec = RID('M');
    await applyRecord(
      { recordId: nRec, version: '1', tombstone: false, payload: { type: 'schemaNotes', connId: CONN_REC, scope: 'app', tables: { t: { note: 'n' } } } },
      s,
    );
    expect(s.unresolved.listForTarget(CONN_REC)).toHaveLength(1);
    const record = s.store.listSchemaNoteRecords()[0];
    expect(record.connId).toBe('');

    await s.mapStore.put(CONN_REC, { type: 'connection', localId: 'c-9', recordVersion: '1', revision: 1, status: 'confirmed' });
    expect(await reconcileUnresolved(s)).toBeGreaterThan(0);
    expect(s.store.getSchemaNoteRecord(record.id)?.connId).toBe('c-9');
    expect(s.store.getSchemaNotes('c-9', 'app').tables['t']?.note).toBe('n');
  });

  it('墓碑 → 本地记录标记删除 + 清映射（跨设备删除传播）', async () => {
    const s = setup();
    await s.mapStore.put(CONN_REC, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 1, status: 'confirmed' });
    const nRec = RID('D');
    await applyRecord(
      { recordId: nRec, version: '1', tombstone: false, payload: { type: 'schemaNotes', connId: CONN_REC, scope: 'app', tables: { t: { note: 'n' } } } },
      s,
    );
    expect((await applyRecord({ recordId: nRec, version: '2', tombstone: true }, s)).disposition).toBe('deleted');
    expect(s.store.getSchemaNotes('c-1', 'app').tables).toEqual({});
    expect(s.store.listSchemaNoteRecords()[0]?.deleted).toBe(true);
    expect(s.mapStore.getByRecordId(nRec)).toBeUndefined();
  });
});

describe('S7f 本地存储：记录式 + 旧格式迁移 + 同步面', () => {
  it('旧格式（<connId>.<库>）可读；保存后迁移到记录式并清理旧键', async () => {
    const s = setup();
    s.memento.data.set(`${SCHEMA_NOTES_PREFIX}c-2.app`, { tables: { old: { note: 'legacy' } } });
    expect(s.store.getSchemaNotes('c-2', 'app').tables['old']?.note).toBe('legacy');

    await s.store.saveTableNote('c-2', 'app', 'new_table', { note: 'fresh', columns: [] });
    expect(s.store.getSchemaNotes('c-2', 'app').tables['new_table']?.note).toBe('fresh');
    expect(s.memento.data.has(`${SCHEMA_NOTES_PREFIX}c-2.app`)).toBe(false);
    const records = s.store.listSchemaNoteRecords();
    expect(records).toHaveLength(1);
    expect(records[0].id.startsWith('sn')).toBe(true);
    expect(records[0].connId).toBe('c-2');
    expect(records[0].updateTime).toBeGreaterThan(0);
    expect(s.memento.data.has(`${SCHEMA_NOTES_RECORD_PREFIX}${records[0].id}`)).toBe(true);
  });

  it('清空全部注记 → 墓碑（记录保留，读面为空），不残留旧键', async () => {
    const s = setup();
    await s.store.saveTableNote('c-3', 'db', 't', { note: 'n', columns: [] });
    await s.store.saveTableNote('c-3', 'db', 't', { note: '', columns: [] });
    expect(s.store.getSchemaNotes('c-3', 'db').tables).toEqual({});
    const records = s.store.listSchemaNoteRecords();
    expect(records).toHaveLength(1);
    expect(records[0].deleted).toBe(true);
  });

  it('EntityStore.listForSync 聚合 schemaNotes（含墓碑与 updateTime）', async () => {
    const s = setup();
    await s.entities.save({ type: 'schemaNotes', localId: 'sn-1' }, { id: 'sn-1', connId: 'c-1', scope: 'app', tables: { t: { note: 'n' } }, updateTime: 0 } as never, 'sync');
    expect(s.entities.get({ type: 'schemaNotes', localId: 'sn-1' })).toMatchObject({ connId: 'c-1', scope: 'app' });
    const listed: EntitySyncRecord[] = s.entities.listForSync().filter((r) => r.ref.type === 'schemaNotes');
    expect(listed).toHaveLength(1);
    expect(listed[0].deleted).toBe(false);
    expect(listed[0].updateTime).toBeGreaterThan(0);

    await s.entities.remove({ type: 'schemaNotes', localId: 'sn-1' }, 'sync');
    const after = s.entities.listForSync().filter((r) => r.ref.type === 'schemaNotes');
    expect(after[0]?.deleted).toBe(true);
  });
});