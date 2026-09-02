import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import { SyncMutator } from '../../../src/sync/e2e/syncMutator';
import { RecordMapStore } from '../../../src/sync/e2e/recordMapStore';
import { PendingMutationStore, type PendingPutMutation, type PendingDeleteMutation } from '../../../src/sync/e2e/pendingMutationStore';
import { openRecord } from '../../../src/sync/e2e/recordCodec';
import type { SavedConnection, ConnectionStore } from '../../../src/connection/connectionStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function conn(id: string, over: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id, name: 'n', dbType: DatabaseType.MYSQL, host: 'localhost', port: 3306, user: 'u',
    updateTime: 100, ...over,
  } as SavedConnection;
}

describe('SyncMutator', () => {
  function setup(connections: SavedConnection[]) {
    const mapStore = new RecordMapStore(makeMemento(), '7', '1');
    const outbox = new PendingMutationStore(makeMemento(), '7', '1');
    const dek = new Uint8Array(32);
    const store = { listForSync: () => connections } as unknown as ConnectionStore;
    const mutator = new SyncMutator({
      userId: '7', keyEpoch: '1', store, mapStore, outbox,
      dek: () => dek, signSeed: () => new Uint8Array(32),
    });
    return { mutator, mapStore, outbox, dek };
  }

  it('新建生成 record.put（baseVersion=0，revision=updateTime，密文可用 recordVersion=1 打开）', async () => {
    const { mutator, outbox, dek } = setup([conn('c-1', { updateTime: 100 })]);
    const r = await mutator.reconcile();
    expect(r.generated).toBe(1);
    expect(outbox.list()).toHaveLength(1);
    const m = outbox.list()[0] as PendingPutMutation;
    expect(m.action).toBe('record.put');
    expect(m.baseVersion).toBe('0');
    expect(m.revision).toBe(100);
    expect(m.consecutiveFailureCount).toBe(0);
    expect(m.connectionId).toBe('c-1');
    const pt = openRecord(dek, Buffer.from(m.nonce, 'base64url'), Buffer.from(m.ciphertext, 'base64url'), Buffer.from(m.tag, 'base64url'), {
      userId: '7', keyEpoch: '1', recordId: m.recordId, recordVersion: '1',
    });
    expect(JSON.parse(Buffer.from(pt).toString('utf8'))).toMatchObject({ name: 'n', host: 'localhost', port: 3306, user: 'u', dbType: 'mysql' });
  });

  it('update 生成 record.put（baseVersion=recordVersion，密文可用 recordVersion=incU64 打开）', async () => {
    const { mutator, mapStore, outbox, dek } = setup([conn('c-1', { updateTime: 200 })]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(1);
    const m = outbox.list()[0] as PendingPutMutation;
    expect(m.baseVersion).toBe('1');
    expect(m.recordId).toBe('A'.repeat(22));
    const pt = openRecord(dek, Buffer.from(m.nonce, 'base64url'), Buffer.from(m.ciphertext, 'base64url'), Buffer.from(m.tag, 'base64url'), {
      userId: '7', keyEpoch: '1', recordId: m.recordId, recordVersion: '2',
    });
    expect(pt.length).toBeGreaterThan(0);
  });

  it('updateTime ≤ revision 无变更', async () => {
    const { mutator, mapStore } = setup([conn('c-1', { updateTime: 100 })]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    expect((await mutator.reconcile()).generated).toBe(0);
  });

  it('软删除墓碑生成 record.delete（baseVersion=recordVersion）', async () => {
    const { mutator, mapStore, outbox } = setup([conn('c-1', { updateTime: 150, deleted: true })]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '3', revision: 100, status: 'confirmed' });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(1);
    const m = outbox.list()[0] as PendingDeleteMutation;
    expect(m.action).toBe('record.delete');
    expect(m.baseVersion).toBe('3');
    expect(m.recordId).toBe('A'.repeat(22));
  });

  it('组织连接跳过（不报错）', async () => {
    const { mutator, outbox } = setup([conn('org:1:2')]);
    const r = await mutator.reconcile();
    expect(r.generated).toBe(0);
    expect(outbox.list()).toHaveLength(0);
  });

  it('pending 映射跳过并汇总上报 recordId', async () => {
    const { mutator, mapStore } = setup([conn('c-1', { updateTime: 200 })]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'pending' });
    const r = await mutator.reconcile();
    expect(r.generated).toBe(0);
    expect(r.pendingSkipped).toEqual([{ recordId: 'A'.repeat(22) }]);
  });

  it('已有 in-flight outbox 条目不重复生成', async () => {
    const { mutator, mapStore, outbox } = setup([conn('c-1', { updateTime: 200 })]);
    await mapStore.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 100, status: 'confirmed' });
    const existing: PendingPutMutation = {
      action: 'record.put', recordId: 'A'.repeat(22), connectionId: 'c-1', baseVersion: '1',
      mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
      signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), revision: 100, consecutiveFailureCount: 0,
    };
    await outbox.put(existing);
    const r = await mutator.reconcile();
    expect(r.generated).toBe(0);
    expect(outbox.list()).toHaveLength(1);
  });

  it('确认后再对账不产生新 mutation', async () => {
    const { mutator, mapStore, outbox } = setup([conn('c-1', { updateTime: 100 })]);
    expect((await mutator.reconcile()).generated).toBe(1);
    const m = outbox.list()[0] as PendingPutMutation;
    await mapStore.put(m.recordId, { connectionId: 'c-1', recordVersion: '1', revision: m.revision, status: 'confirmed' });
    await outbox.clear();
    expect((await mutator.reconcile()).generated).toBe(0);
  });
});