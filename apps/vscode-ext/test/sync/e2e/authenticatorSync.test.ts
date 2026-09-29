import { describe, expect, it } from 'vitest';
import { applyRecord, reconcileUnresolved } from '@devbelt/db-host/sync/e2e/applyRecords';
import { RecordMapStore } from '@devbelt/db-host/sync/e2e/recordMapStore';
import { EntityStore, UnresolvedRefStore, type EntityBackend, type EntitySyncRecord } from '@devbelt/db-host/sync/e2e/entityStore';
import { encodeEntityPayload, decodeEntityPayload } from '@devbelt/db-host/sync/e2e/recordCodec';
import type { SyncEntityType, SyncEntityRef } from '@devbelt/db-host/sync/e2e/syncEntity';
import type { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import type {
  SyncAuthenticatorGroup, SyncAuthenticatorTag, SyncAuthenticatorEntryValue,
} from '@devbelt/db-host/sync/e2e/authenticatorTypes';

const SECRET = 'JBSWY3DPEHPK3PXP';
const RID = (ch: string) => ch.repeat(22);

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

/** 内存化验证器同步后端：save 后 get 必须返回带数值 updateTime 的实体（对账/冲突依赖）。 */
function makeAuthBackend() {
  const groups = new Map<string, SyncAuthenticatorGroup & { updateTime: number }>();
  const tags = new Map<string, SyncAuthenticatorTag & { updateTime: number }>();
  const entries = new Map<string, SyncAuthenticatorEntryValue>();
  let clock = 5000;
  const tick = () => ++clock;
  const backend: EntityBackend = {
    listForSync(): EntitySyncRecord[] {
      return [
        ...[...groups.values()].map((g) => ({ ref: { type: 'authenticatorGroup' as const, localId: g.id }, deleted: false, updateTime: g.updateTime })),
        ...[...tags.values()].map((t) => ({ ref: { type: 'authenticatorTag' as const, localId: t.id }, deleted: false, updateTime: t.updateTime })),
        ...[...entries.values()].map((e) => ({ ref: { type: 'authenticatorEntry' as const, localId: e.id }, deleted: false, updateTime: e.updateTime })),
      ];
    },
    get(ref: SyncEntityRef) {
      if (ref.type === 'authenticatorGroup') return groups.get(ref.localId);
      if (ref.type === 'authenticatorTag') return tags.get(ref.localId);
      if (ref.type === 'authenticatorEntry') return entries.get(ref.localId);
      return undefined;
    },
    async save(ref: SyncEntityRef, entity: unknown) {
      if (ref.type === 'authenticatorGroup') {
        const g = entity as SyncAuthenticatorGroup;
        groups.set(ref.localId, { id: ref.localId, name: g.name, sortOrder: g.sortOrder, updateTime: tick() });
      } else if (ref.type === 'authenticatorTag') {
        const t = entity as SyncAuthenticatorTag;
        tags.set(ref.localId, { id: ref.localId, name: t.name, color: t.color, updateTime: tick() });
      } else if (ref.type === 'authenticatorEntry') {
        const e = entity as SyncAuthenticatorEntryValue;
        entries.set(ref.localId, { ...e, id: ref.localId, updateTime: e.updateTime || tick() });
      }
    },
    async remove(ref: SyncEntityRef) {
      if (ref.type === 'authenticatorGroup') groups.delete(ref.localId);
      else if (ref.type === 'authenticatorTag') tags.delete(ref.localId);
      else if (ref.type === 'authenticatorEntry') entries.delete(ref.localId);
    },
  };
  return { backend, groups, tags, entries };
}

const emptyPersonalStore = {
  listForSync: () => [], listGroupsForSync: () => [], listFoldersForSync: () => [], listQueriesForSync: () => [],
  get: () => undefined, getGroupById: () => undefined, getFolderById: () => undefined, getQueryById: () => undefined,
  save: async () => {}, remove: async () => {}, upsertGroup: async () => {}, removeGroup: async () => {},
  upsertFolder: async () => {}, removeQueryFolder: async () => {}, upsertQuery: async () => {}, removeQuery: async () => {},
} as unknown as ConnectionStore;

function setup() {
  const auth = makeAuthBackend();
  const entities = new EntityStore(emptyPersonalStore, auth.backend);
  const mapStore = new RecordMapStore(makeMemento(), '7', '1');
  const unresolved = new UnresolvedRefStore(makeMemento(), '7', '1');
  let counter = 0;
  const prefix: Record<SyncEntityType, string> = {
    connection: 'c', group: 'g', queryFolder: 'qf', query: 'q',
    authenticatorEntry: 'ae', authenticatorGroup: 'ag', authenticatorTag: 'at',
  };
  const uniqueId = (type: SyncEntityType) => `${prefix[type]}-${++counter}`;
  return { ...auth, entities, mapStore, unresolved, uniqueId };
}

const entryEntity: SyncAuthenticatorEntryValue = {
  id: 'ae-1', issuer: 'Acme', account: 'alice', algorithm: 'SHA1', digits: 6, period: 30,
  groupId: 'ag-local', tags: ['at-local'], createTime: 1, updateTime: 2, secret: SECRET,
};

describe('P6 codec：验证器实体', () => {
  it('entry 编码含 secret/引用，且不含 localOnly/syncError', () => {
    const payload = encodeEntityPayload(
      { type: 'authenticatorEntry', entity: { ...entryEntity, localOnly: true, syncError: 'quota' } },
      (type, localId) => (localId ? `${type}:${localId}` : undefined),
    );
    expect(payload).toMatchObject({ type: 'authenticatorEntry', issuer: 'Acme', secret: SECRET });
    expect(payload.groupId).toBe('authenticatorGroup:ag-local');
    expect(payload.tags).toEqual(['authenticatorTag:at-local']);
    expect('localOnly' in payload).toBe(false);
    expect('syncError' in payload).toBe(false);
  });

  it('entry 编码→解码 roundtrip', () => {
    const payload = encodeEntityPayload({ type: 'authenticatorEntry', entity: entryEntity }, () => undefined);
    const decoded = decodeEntityPayload(payload);
    expect(decoded.type).toBe('authenticatorEntry');
    if (decoded.type !== 'authenticatorEntry') return;
    expect(decoded.data.issuer).toBe('Acme');
    expect(decoded.data.secret).toBe(SECRET);
    expect(decoded.data.digits).toBe(6);
    expect(decoded.data.createTime).toBe(1);
  });

  it('group/tag roundtrip 与颜色白名单', () => {
    const g = decodeEntityPayload(encodeEntityPayload({ type: 'authenticatorGroup', entity: { id: 'ag', name: 'G', sortOrder: 10 } }, () => undefined));
    expect(g).toEqual({ type: 'authenticatorGroup', data: { name: 'G', sortOrder: 10 } });
    const t = decodeEntityPayload(encodeEntityPayload({ type: 'authenticatorTag', entity: { id: 'at', name: 'T', color: 'cyan' } }, () => undefined));
    expect(t).toEqual({ type: 'authenticatorTag', data: { name: 'T', color: 'cyan' } });
    expect(() => encodeEntityPayload({ type: 'authenticatorTag', entity: { id: 'at', name: 'T', color: 'magenta' as never } }, () => undefined)).toThrow(/color/);
  });

  it('拒非法 secret（小写/超长/非 base32）', () => {
    for (const bad of ['jbswy3dpehpk3pxp', '0189', 'A'.repeat(600)]) {
      expect(() => encodeEntityPayload({ type: 'authenticatorEntry', entity: { ...entryEntity, secret: bad } }, () => undefined)).toThrow(/secret/);
    }
  });

  it('解码忽略多带字段：localOnly 不被采纳（D14 向前兼容）', () => {
    const payload = encodeEntityPayload({ type: 'authenticatorEntry', entity: entryEntity }, () => undefined);
    const decoded = decodeEntityPayload({ ...payload, localOnly: true });
    expect(decoded.type).toBe('authenticatorEntry');
    expect((decoded.data as unknown as Record<string, unknown>).localOnly).toBeUndefined();
  });
});

describe('P6 apply：验证器实体（拓扑/引用/未决）', () => {
  it('group/tag/entry 依次应用；entry 引用解析为本地 id', async () => {
    const s = setup();
    const gRec = RID('G'); const tRec = RID('T'); const eRec = RID('E');
    expect((await applyRecord({ recordId: gRec, version: '1', tombstone: false, payload: { type: 'authenticatorGroup', name: 'G', sortOrder: 10 } }, s)).disposition).toBe('created');
    expect((await applyRecord({ recordId: tRec, version: '1', tombstone: false, payload: { type: 'authenticatorTag', name: 'T', color: 'blue' } }, s)).disposition).toBe('created');
    expect((await applyRecord({ recordId: eRec, version: '1', tombstone: false, payload: { type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: SECRET, groupId: gRec, tags: [tRec], createTime: 1, updateTime: 2 } }, s)).disposition).toBe('created');
    const entry = [...s.entries.values()][0];
    expect(entry.groupId).toBe(s.mapStore.getByRecordId(gRec)!.localId);
    expect(entry.tags).toEqual([s.mapStore.getByRecordId(tRec)!.localId]);
  });

  it('entry 先到、引用未映射 → unresolved，后到 group 经 reconcile 收敛', async () => {
    const s = setup();
    const gRec = RID('H'); const eRec = RID('F');
    await applyRecord({ recordId: eRec, version: '1', tombstone: false, payload: { type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: SECRET, groupId: gRec, createTime: 1, updateTime: 2 } }, s);
    expect(s.unresolved.listForTarget(gRec)).toHaveLength(1);
    await applyRecord({ recordId: gRec, version: '1', tombstone: false, payload: { type: 'authenticatorGroup', name: 'G', sortOrder: 1 } }, s);
    expect(await reconcileUnresolved(s)).toBeGreaterThan(0);
    const entry = [...s.entries.values()][0];
    expect(entry.groupId).toBe(s.mapStore.getByRecordId(gRec)!.localId);
  });

  it('tombstone 删除已验证条目 + 清映射', async () => {
    const s = setup();
    const eRec = RID('K');
    await applyRecord({ recordId: eRec, version: '1', tombstone: false, payload: { type: 'authenticatorEntry', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, secret: SECRET, createTime: 1, updateTime: 2 } }, s);
    expect(s.entries.size).toBe(1);
    expect((await applyRecord({ recordId: eRec, version: '2', tombstone: true }, s)).disposition).toBe('deleted');
    expect(s.entries.size).toBe(0);
    expect(s.mapStore.getByRecordId(eRec)).toBeUndefined();
  });

  it('EntityStore.listForSync 聚合验证器三类', async () => {
    const s = setup();
    await s.entities.save({ type: 'authenticatorGroup', localId: 'ag-1' }, { id: 'ag-1', name: 'G', sortOrder: 1 } as never, 'sync');
    await s.entities.save({ type: 'authenticatorTag', localId: 'at-1' }, { id: 'at-1', name: 'T', color: 'green' } as never, 'sync');
    await s.entities.save({ type: 'authenticatorEntry', localId: 'ae-1' }, { ...entryEntity, id: 'ae-1' } as never, 'sync');
    const refs = s.entities.listForSync().map((r) => r.ref.type).sort();
    expect(refs).toEqual(['authenticatorEntry', 'authenticatorGroup', 'authenticatorTag']);
  });
});
