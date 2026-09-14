import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import { sealRecord } from '../../../src/sync/e2e/recordCodec';
import { ConflictResolver } from '../../../src/sync/e2e/conflictResolver';
import { RecordMapStore } from '../../../src/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingDeleteMutation, type PendingPutMutation } from '../../../src/sync/e2e/pendingMutationStore';
import { EntityStore, UnresolvedRefStore } from '../../../src/sync/e2e/entityStore';
import { SyncMutator } from '../../../src/sync/e2e/syncMutator';
import type { ConnectionStore, SavedConnection } from '../../../src/connection/connectionStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function makeStore(seed: SavedConnection[]): ConnectionStore {
  const conns = new Map<string, SavedConnection>(seed.map((c) => [c.id, c]));
  return {
    get: (id: string) => conns.get(id),
    save: async (c: SavedConnection) => { conns.set(c.id, { ...c, updateTime: Date.now() }); },
    remove: async (id: string) => { conns.delete(id); },
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
  } as unknown as ConnectionStore;
}

const id = 'A'.repeat(22);
const dek = new Uint8Array(32).fill(7);
const signSeed = new Uint8Array(32).fill(9);

function sealedConnection(recordId: string, version: string, data: Record<string, unknown>) {
  const nonce = new Uint8Array(12).fill(1);
  const plaintext = Buffer.from(JSON.stringify({ type: 'connection', ...data }), 'utf8');
  const box = sealRecord(dek, nonce, plaintext, { userId: '7', keyEpoch: '1', recordId, recordVersion: version });
  return {
    nonce: Buffer.from(nonce).toString('base64url'),
    ciphertext: Buffer.from(box.ciphertext).toString('base64url'),
    tag: Buffer.from(box.tag).toString('base64url'),
  };
}

function makeResolver(over: { memento?: ReturnType<typeof makeMemento>; store?: ConnectionStore }) {
  const memento = over.memento ?? makeMemento();
  const mapStore = new RecordMapStore(memento, '7', '1');
  const outbox = new PendingMutationStore(memento, '7', '1');
  const store = over.store ?? makeStore([{ id: 'c-1', name: 'Local', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', updateTime: 100 } as SavedConnection]);
  const entities = new EntityStore(store);
  const mutator = new SyncMutator({
    userId: '7', keyEpoch: '1', entities, mapStore, outbox,
    dek: () => dek, signSeed: () => signSeed,
  });
  return {
    resolver: new ConflictResolver({
      userId: '7', keyEpoch: '1', mapStore, outbox, entities,
      unresolved: new UnresolvedRefStore(memento, '7', '1'),
      dek: () => dek, mutator,
      uniqueId: (t) => `new-${t}`,
    }),
    mapStore, outbox, store,
  };
}

function putMutation(recordId: string, localId: string, baseVersion: string): PendingPutMutation {
  return {
    action: 'record.put', recordId, type: 'connection', localId, baseVersion,
    mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
    signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), revision: 100, consecutiveFailureCount: 0,
  };
}

function deleteMutation(recordId: string, localId: string, baseVersion: string): PendingDeleteMutation {
  return {
    action: 'record.delete', recordId, type: 'connection', localId, baseVersion,
    mutationId: 'B'.repeat(22), signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), revision: 100, consecutiveFailureCount: 0,
  };
}

describe('ConflictResolver', () => {
  it('useLocal：rebase 到 currentVersion，替换 outbox mutation（无 conflict）', async () => {
    const { resolver, mapStore, outbox } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7' });

    await resolver.useLocal(id);

    const listed = outbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].baseVersion).toBe('7');
    expect(listed[0].conflict).toBeUndefined();
    expect(listed[0].mutationId).not.toBe(m.mutationId);
  });

  it('useRemote：解密远端并强制应用，删除 outbox 条目', async () => {
    const { resolver, mapStore, outbox, store } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const sealed = sealedConnection(id, '7', { dbType: 'mysql', name: 'Remote Name', host: 'rh', port: 3306, user: 'ru' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, {
      kind: 'version', currentVersion: '7', remoteRecordVersion: '7',
      remoteNonce: sealed.nonce, remoteCiphertext: sealed.ciphertext, remoteTag: sealed.tag,
      remoteTombstone: false,
    });

    await resolver.useRemote(id);

    expect(outbox.list()).toHaveLength(0);
    expect((store.get('c-1') as SavedConnection).name).toBe('Remote Name');
  });

  it('useRemote 密文未就绪（远端 active 但无密文）→ 抛错', async () => {
    const { resolver, mapStore, outbox } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7', remoteTombstone: false });

    await expect(resolver.useRemote(id)).rejects.toThrowError(/ciphertext not yet available/);
  });

  it('useRemote 远端版本未拉取（remoteTombstone undefined）→ 抛错', async () => {
    const { resolver, mapStore, outbox } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7' });

    await expect(resolver.useRemote(id)).rejects.toThrowError(/remote version not yet fetched/);
  });

  it('useLocal 对 delete 冲突保留 record.delete（不只生成 put）', async () => {
    const { resolver, mapStore, outbox } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = deleteMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7' });

    await resolver.useLocal(id);

    const listed = outbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].action).toBe('record.delete');
    expect(listed[0].baseVersion).toBe('7');
    expect(listed[0].conflict).toBeUndefined();
  });

  it('useRemote 对 delete 冲突但远端 active（有密文）→ 还原远端 active，不删本地', async () => {
    const { resolver, mapStore, outbox, store } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const sealed = sealedConnection(id, '7', { dbType: 'mysql', name: 'Remote Keep', host: 'rh', port: 3306, user: 'ru' });
    const m = deleteMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, {
      kind: 'version', currentVersion: '7', remoteRecordVersion: '7',
      remoteNonce: sealed.nonce, remoteCiphertext: sealed.ciphertext, remoteTag: sealed.tag,
      remoteTombstone: false,
    });

    await resolver.useRemote(id);

    expect(outbox.list()).toHaveLength(0);
    expect((store.get('c-1') as SavedConnection).name).toBe('Remote Keep');
  });

  it('useRemote 对 delete 冲突且远端 tombstone（remoteTombstone=true）→ 删本地', async () => {
    const { resolver, mapStore, outbox, store } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = deleteMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7', remoteTombstone: true });

    await resolver.useRemote(id);

    expect(outbox.list()).toHaveLength(0);
    expect(store.get('c-1') as SavedConnection | undefined).toBeUndefined();
  });

  it('useRemote 对 put 冲突且远端 tombstone（remoteTombstone=true）→ 删本地（不抛密文未就绪）', async () => {
    const { resolver, mapStore, outbox, store } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7', remoteTombstone: true });

    await resolver.useRemote(id);

    expect(outbox.list()).toHaveLength(0);
    expect(store.get('c-1') as SavedConnection | undefined).toBeUndefined();
  });

  it('useMerge：远端为基、本地非空覆盖，写回本地并替换为无冲突 mutation', async () => {
    const { resolver, mapStore, outbox, store } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const sealed = sealedConnection(id, '7', { dbType: 'mysql', name: 'Remote Name', host: 'rh', port: 3306, user: 'ru', password: 'remote-pw' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, {
      kind: 'version', currentVersion: '7', remoteRecordVersion: '7',
      remoteNonce: sealed.nonce, remoteCiphertext: sealed.ciphertext, remoteTag: sealed.tag, remoteTombstone: false,
    });

    await resolver.useMerge(id);

    const c = store.get('c-1') as SavedConnection;
    expect(c.name).toBe('Local'); // 本地非空优先
    expect(c.password).toBe('remote-pw'); // 本地缺失的字段取远端
    const listed = outbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].baseVersion).toBe('7');
    expect(listed[0].conflict).toBeUndefined();
  });

  it('useMerge：本地 delete 冲突退化为 Use Local（保留 record.delete）', async () => {
    const { resolver, mapStore, outbox } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = deleteMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7', remoteTombstone: false });

    await resolver.useMerge(id);

    const listed = outbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].action).toBe('record.delete');
    expect(listed[0].baseVersion).toBe('7');
  });

  it('useMerge：远端 tombstone 退化为 Use Remote（删本地）', async () => {
    const { resolver, mapStore, outbox, store } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7', remoteTombstone: true });

    await resolver.useMerge(id);

    expect(outbox.list()).toHaveLength(0);
    expect(store.get('c-1') as SavedConnection | undefined).toBeUndefined();
  });

  it('useMerge：远端 active 但密文未就绪 → 抛错', async () => {
    const { resolver, mapStore, outbox } = makeResolver({});
    await mapStore.put(id, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const m = putMutation(id, 'c-1', '0');
    await outbox.put(m);
    await outbox.setConflict(m.mutationId, { kind: 'version', currentVersion: '7', remoteRecordVersion: '7', remoteTombstone: false });

    await expect(resolver.useMerge(id)).rejects.toThrowError(/ciphertext not yet available/);
  });
});