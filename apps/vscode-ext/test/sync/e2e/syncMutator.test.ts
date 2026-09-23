import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { SyncMutator } from '@devbelt/db-host/sync/e2e/syncMutator';
import { RecordMapStore } from '@devbelt/db-host/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingPutMutation, type PendingDeleteMutation } from '@devbelt/db-host/sync/e2e/pendingMutationStore';
import { EntityStore } from '@devbelt/db-host/sync/e2e/entityStore';
import { openRecord } from '@devbelt/db-host/sync/e2e/recordCodec';
import type { SavedConnection, ConnectionGroup, ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import type { QueryFolder } from '@devbelt/db-host/connection/queryStore';
import type { SavedQuery } from '@devbelt/db-core';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

// 内存化的 ConnectionStore 仿真：只实现 sync 关心的只读面。
function makeConnectionStore(data: {
  connections?: SavedConnection[];
  groups?: ConnectionGroup[];
  folders?: QueryFolder[];
  queries?: SavedQuery[];
}): ConnectionStore {
  return {
    listForSync: () => data.connections ?? [],
    listGroupsForSync: () => data.groups ?? [],
    listFoldersForSync: () => data.folders ?? [],
    listQueriesForSync: () => data.queries ?? [],
    get: (id: string) => (data.connections ?? []).find((c) => c.id === id),
    getGroupById: (id: string) => (data.groups ?? []).find((g) => g.id === id),
    getFolderById: (id: string) => (data.folders ?? []).find((f) => f.id === id),
    getQueryById: (id: string) => (data.queries ?? []).find((q) => q.id === id),
  } as unknown as ConnectionStore;
}

function conn(id: string, over: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id, name: 'n', dbType: DatabaseType.MYSQL, host: 'localhost', port: 3306, user: 'u',
    updateTime: 100, ...over,
  } as SavedConnection;
}

const dek32 = () => new Uint8Array(32);

function setup(data: Parameters<typeof makeConnectionStore>[0]) {
  const mapStore = new RecordMapStore(makeMemento(), '7', '1');
  const outbox = new PendingMutationStore(makeMemento(), '7', '1');
  const entities = new EntityStore(makeConnectionStore(data));
  const mutator = new SyncMutator({
    userId: '7', keyEpoch: '1', entities, mapStore, outbox,
    dek: dek32, signSeed: () => new Uint8Array(32),
  });
  return { mutator, mapStore, outbox, entities };
}

describe('SyncMutator（全类型）', () => {
  it('新建连接生成 record.put（baseVersion=0，revision=updateTime，密文含 type+engine）', async () => {
    const { mutator, outbox } = setup({ connections: [conn('c-1', { updateTime: 100 })] });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(1);
    const m = outbox.list()[0] as PendingPutMutation;
    expect(m.action).toBe('record.put');
    expect(m.type).toBe('connection');
    expect(m.localId).toBe('c-1');
    expect(m.baseVersion).toBe('0');
    expect(m.revision).toBe(100);
    const pt = openRecord(dek32(), Buffer.from(m.nonce, 'base64url'), Buffer.from(m.ciphertext, 'base64url'), Buffer.from(m.tag, 'base64url'), {
      userId: '7', keyEpoch: '1', recordId: m.recordId, recordVersion: '1',
    });
    expect(JSON.parse(Buffer.from(pt).toString('utf8'))).toMatchObject({ type: 'connection', dbType: 'mysql', name: 'n', host: 'localhost' });
  });

  it('update 生成 record.put（baseVersion=recordVersion）', async () => {
    const { mutator, mapStore, outbox } = setup({ connections: [conn('c-1', { updateTime: 200 })] });
    await mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(1);
    const m = outbox.list()[0] as PendingPutMutation;
    expect(m.baseVersion).toBe('1');
    expect(m.recordId).toBe('A'.repeat(22));
    const pt = openRecord(dek32(), Buffer.from(m.nonce, 'base64url'), Buffer.from(m.ciphertext, 'base64url'), Buffer.from(m.tag, 'base64url'), {
      userId: '7', keyEpoch: '1', recordId: m.recordId, recordVersion: '2',
    });
    expect(pt.length).toBeGreaterThan(0);
  });

  it('updateTime ≤ revision 无变更', async () => {
    const { mutator, mapStore } = setup({ connections: [conn('c-1', { updateTime: 100 })] });
    await mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    expect((await mutator.reconcile()).generated).toBe(0);
  });

  it('软删除墓碑生成 record.delete（baseVersion=recordVersion）', async () => {
    const { mutator, mapStore, outbox } = setup({ connections: [conn('c-1', { updateTime: 150, deleted: true })] });
    await mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '3', revision: 100, status: 'confirmed' });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(1);
    const m = outbox.list()[0] as PendingDeleteMutation;
    expect(m.action).toBe('record.delete');
    expect(m.baseVersion).toBe('3');
    expect(m.type).toBe('connection');
  });

  it('四类型各自产生 mutation，引用转 recordId 有序 mint', async () => {
    const { mutator, outbox } = setup({
      groups: [{ id: 'g-1', name: 'Root', updateTime: 100 } as ConnectionGroup],
      folders: [{ id: 'qf-1', name: 'F', connId: 'c-1', updateTime: 100 } as QueryFolder],
      connections: [conn('c-1', { groupId: 'g-1', updateTime: 100 })],
      queries: [{ id: 'q-1', name: 'Q', sql: 'SELECT 1', connId: 'c-1', folderId: 'qf-1', updateTime: 100 } as unknown as SavedQuery],
    });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(4);
    const byType = new Map(outbox.list().map((m) => [m.type, m]));

    // group 先 mint，connection 的 groupId 应引用其 recordId
    const groupPut = byType.get('group') as PendingPutMutation;
    const connPut = byType.get('connection') as PendingPutMutation;
    const floderPut = byType.get('queryFolder') as PendingPutMutation;
    const queryPut = byType.get('query') as PendingPutMutation;

    expect(groupPut).toBeDefined();
    const groupPayload = JSON.parse(decodePlain(groupPut));
    expect(groupPayload).toMatchObject({ type: 'group', name: 'Root' });

    const connPayload = JSON.parse(decodePlain(connPut));
    expect(connPayload.groupId).toBe(groupPut.recordId);

    const floderPayload = JSON.parse(decodePlain(floderPut));
    expect(floderPayload.connId).toBe(connPut.recordId);

    const queryPayload = JSON.parse(decodePlain(queryPut));
    expect(queryPayload.connId).toBe(connPut.recordId);
    expect(queryPayload.folderId).toBe(floderPut.recordId);
  });

  it('pending 映射跳过并汇总上报 recordId', async () => {
    const { mutator, mapStore } = setup({ connections: [conn('c-1', { updateTime: 200 })] });
    await mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'pending' });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(0);
    expect(r.pendingSkipped).toEqual([{ recordId: 'A'.repeat(22) }]);
  });

  it('已有 in-flight outbox 条目不重复生成', async () => {
    const { mutator, mapStore, outbox } = setup({ connections: [conn('c-1', { updateTime: 200 })] });
    await mapStore.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const existing: PendingPutMutation = {
      action: 'record.put', recordId: 'A'.repeat(22), type: 'connection', localId: 'c-1', baseVersion: '1',
      mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
      signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), revision: 100, consecutiveFailureCount: 0,
    };
    await outbox.put(existing);
    const r = await mutator.reconcile();
    expect(r.generated).toBe(0);
    expect(outbox.list()).toHaveLength(1);
  });

  it('确认后再对账不产生新 mutation', async () => {
    const { mutator, mapStore, outbox } = setup({ connections: [conn('c-1', { updateTime: 100 })] });
    expect((await mutator.reconcile()).generated).toBe(1);
    const m = outbox.list()[0] as PendingPutMutation;
    await mapStore.put(m.recordId, { type: 'connection', localId: 'c-1', recordVersion: '1', revision: m.revision, status: 'confirmed' });
    await outbox.clear();
    expect((await mutator.reconcile()).generated).toBe(0);
  });
});

function decodePlain(m: PendingPutMutation): string {
  return Buffer.from(openRecord(dek32(), Buffer.from(m.nonce, 'base64url'), Buffer.from(m.ciphertext, 'base64url'), Buffer.from(m.tag, 'base64url'), {
    userId: '7', keyEpoch: '1', recordId: m.recordId, recordVersion: m.baseVersion === '0' ? '1' : (BigInt(m.baseVersion) + 1n).toString(),
  })).toString('utf8');
}