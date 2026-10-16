import { describe, expect, it } from 'vitest';
import { applyRecord } from '@devbelt/db-host/sync/e2e/applyRecords';
import { RecordMapStore } from '@devbelt/db-host/sync/e2e/recordMapStore';
import { EntityStore, UnresolvedRefStore, type EntitySyncRecord } from '@devbelt/db-host/sync/e2e/entityStore';
import { encodeEntityPayload, decodeEntityPayload } from '@devbelt/db-host/sync/e2e/recordCodec';
import type { SyncEntityType } from '@devbelt/db-host/sync/e2e/syncEntity';
import type { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import { AiModelAccessStore } from '../../../src/ai/aiModelAccessStore';
import { ModelAccessSyncBackend } from '../../../src/ai/modelAccessSyncBackend';

const RID = (ch: string) => ch.repeat(22);

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

function makeKeys(initial?: string) {
  let key = initial;
  const written: string[] = [];
  return {
    written,
    peekApiKey: () => key,
    setApiKey: async (k: string) => {
      key = k;
      written.push(k);
    },
    hasApiKey: async () => !!key,
  };
}

function setup(prefs = { selection: true, custom: true, key: true }, initialKey?: string) {
  const memento = makeMemento();
  memento.data.set('devbelt.ai.modelAccess.syncPrefs', prefs);
  let tick = 1000;
  const store = new AiModelAccessStore(memento as never, () => ++tick);
  const keys = makeKeys(initialKey);
  const applied: Array<Record<string, unknown>> = [];
  const needsKey: string[] = [];
  const backend = new ModelAccessSyncBackend(store, keys, {
    applyRuntime: async (fields) => {
      applied.push({ ...fields });
    },
    onNeedsKey: () => needsKey.push('need'),
  });
  const entities = new EntityStore(emptyPersonalStore, undefined, undefined, backend);
  const mapStore = new RecordMapStore(makeMemento() as never, '7', '1');
  const unresolved = new UnresolvedRefStore(makeMemento() as never, '7', '1');
  let counter = 0;
  const prefix: Record<SyncEntityType, string> = {
    connection: 'c', group: 'g', queryFolder: 'qf', query: 'q',
    authenticatorEntry: 'ae', authenticatorGroup: 'ag', authenticatorTag: 'at',
    schemaNotes: 'sn', aiModelAccess: 'ma',
  };
  const uniqueId = (type: SyncEntityType) => `${prefix[type]}-${++counter}`;
  return { memento, store, keys, backend, entities, mapStore, unresolved, uniqueId, applied, needsKey };
}

const SELECTION = { mode: 'openai-compatible' as const, vendorId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
const CUSTOM = { customVendors: [{ id: 'cv-1', name: '内网代理', baseUrl: 'https://proxy.internal/v1', models: ['llama3'] }], customModels: { openai: ['gpt-4o-custom'] } };

describe('aiModelAccess codec：选择性同步（部分组）', () => {
  it('出站只带勾选组；往返一致', () => {
    const full = encodeEntityPayload({ type: 'aiModelAccess', entity: { id: 'ma-1', selection: SELECTION, custom: CUSTOM, apiKey: 'sk-1', updateTime: 5 } }, () => undefined);
    expect(full).toMatchObject({ type: 'aiModelAccess', selection: SELECTION, apiKey: 'sk-1' });
    expect(decodeEntityPayload(full)).toEqual({ type: 'aiModelAccess', data: { selection: SELECTION, custom: CUSTOM, apiKey: 'sk-1' } });

    const partial = encodeEntityPayload({ type: 'aiModelAccess', entity: { id: 'ma-1', selection: SELECTION, updateTime: 5 } }, () => undefined);
    expect('custom' in (partial as object)).toBe(false);
    expect('apiKey' in (partial as object)).toBe(false);
  });

  it('空 payload / apiKey 带空白 / 超限拒绝（fail-closed）', () => {
    expect(() => decodeEntityPayload({ type: 'aiModelAccess' })).toThrow();
    expect(() => decodeEntityPayload({ type: 'aiModelAccess', apiKey: 'sk 1' })).toThrow();
    expect(() => decodeEntityPayload({ type: 'aiModelAccess', custom: { customVendors: Array.from({ length: 21 }, (_, i) => ({ id: `v${i}`, name: 'n', baseUrl: 'https://a.com', models: [] })), customModels: {} } })).toThrow();
    expect(() => decodeEntityPayload({ type: 'aiModelAccess', selection: { mode: 'weird' } })).toThrow();
  });
});

describe('aiModelAccess 入站合并（本机勾选双向生效）', () => {
  it('全开：选择/自定义覆盖；payload 带 Key 写入密钥面；runtime 应用', async () => {
    const s = setup(undefined, 'local-key');
    const rec = RID('A');
    const r = await applyRecord(
      { recordId: rec, version: '1', tombstone: false, payload: { type: 'aiModelAccess', selection: SELECTION, custom: CUSTOM, apiKey: 'remote-key' } },
      s,
    );
    expect(r.disposition).toBe('created');
    expect(s.store.current()).toMatchObject(SELECTION);
    expect(s.store.current().customVendors).toHaveLength(1);
    expect(s.keys.written).toEqual(['remote-key']);
    expect(s.applied).toHaveLength(1);
  });

  it('本机关闭「当前选择」：入站选择组被忽略，本机值保留；自定义组仍合并', async () => {
    const s = setup({ selection: false, custom: true, key: true });
    await s.store.saveLocal({ mode: 'server-proxy', vendorId: '', baseUrl: '', model: '', customVendors: [], customModels: {} });
    await applyRecord(
      { recordId: RID('B'), version: '1', tombstone: false, payload: { type: 'aiModelAccess', selection: SELECTION, custom: CUSTOM } },
      s,
    );
    expect(s.store.current()).toMatchObject({ mode: 'server-proxy', vendorId: '', baseUrl: '', model: '' });
    expect(s.store.current().customVendors).toHaveLength(1);
  });

  it('本机关闭「同步 Key」：payload 的 Key 不写入，本机 Key 保留（不清空）', async () => {
    const s = setup({ selection: true, custom: true, key: false }, 'local-key');
    await applyRecord(
      { recordId: RID('C'), version: '1', tombstone: false, payload: { type: 'aiModelAccess', selection: SELECTION, apiKey: 'remote-key' } },
      s,
    );
    expect(s.keys.written).toEqual([]);
    expect(await s.keys.hasApiKey()).toBe(true);
  });

  it('无本机记录时以默认值为合并基线；byok 无 Key → onNeedsKey', async () => {
    const s = setup();
    await applyRecord(
      { recordId: RID('D'), version: '1', tombstone: false, payload: { type: 'aiModelAccess', custom: CUSTOM } },
      s,
    );
    expect(s.store.current()).toMatchObject({ mode: 'server-proxy' });
    await applyRecord(
      { recordId: RID('E'), version: '1', tombstone: false, payload: { type: 'aiModelAccess', selection: SELECTION } },
      s,
    );
    expect(s.needsKey).toEqual(['need']);
  });
});

describe('aiModelAccess 出站（get 按勾选裁剪）与墓碑', () => {
  it('get：关闭的组不出现在值里', async () => {
    const s = setup({ selection: true, custom: false, key: false }, 'local-key');
    const rec = await s.store.saveLocal({ ...SELECTION, ...CUSTOM });
    const value = s.backend.get({ type: 'aiModelAccess', localId: rec.id }) as unknown as Record<string, unknown>;
    expect(value.selection).toEqual(SELECTION);
    expect('custom' in value).toBe(false);
    expect('apiKey' in value).toBe(false);
  });

  it('墓碑 → 记录标记删除 + 清映射；listForSync 反映删除', async () => {
    const s = setup();
    const rec = await s.store.saveLocal({ ...SELECTION, ...CUSTOM });
    const rid = RID('F');
    await s.mapStore.put(rid, { type: 'aiModelAccess', localId: rec.id, recordVersion: '1', revision: rec.updateTime, status: 'confirmed' });
    expect((await applyRecord({ recordId: rid, version: '2', tombstone: true }, s)).disposition).toBe('deleted');
    expect(s.store.getRecord(rec.id)?.deleted).toBe(true);
    expect(s.mapStore.getByRecordId(rid)).toBeUndefined();
    const list: EntitySyncRecord[] = s.backend.listForSync();
    expect(list.find((e) => e.ref.localId === rec.id)?.deleted).toBe(true);
  });
});
