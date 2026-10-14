import { describe, expect, it } from 'vitest';
import { ConnectionStore, type SavedConnection } from '../src/connection/connectionStore.js';
import { EntityStore, UnresolvedRefStore } from '../src/sync/e2e/entityStore.js';
import { RecordMapStore } from '../src/sync/e2e/recordMapStore.js';
import { PendingMutationStore } from '../src/sync/e2e/pendingMutationStore.js';
import { SyncMutator } from '../src/sync/e2e/syncMutator.js';
import { applyRecord, type ApplyContext } from '../src/sync/e2e/applyRecords.js';
import { openRecord } from '../src/sync/e2e/recordCodec.js';

/**
 * 删除→重新添加 生命周期回归（S7k.2a）。
 * 覆盖四类个人同步实体：删除 → reconcile 生成 delete mutation → 确认（映射删除）→
 * 重新添加 → reconcile 生成 put mutation（新 recordId）；并用 recordCodec 的原密文
 * 在「另一端」重放（applyRecord）验证收敛（旧实体删/忽略、新实体存活）。
 */

const USER = '7';
const EPOCH = '1';
const DEK = new Uint8Array(32);

function memento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    async update(k: string, v: unknown) { m.set(k, v); },
  };
}

const secrets = { async get() { return undefined; }, async store() {}, async delete() {} };

interface World {
  store: ConnectionStore;
  entities: EntityStore;
  mapStore: RecordMapStore;
  outbox: PendingMutationStore;
  mutator: SyncMutator;
}

function world(): World {
  const store = new ConnectionStore(memento() as never, secrets);
  const entities = new EntityStore(store);
  const mapStore = new RecordMapStore(memento() as never, USER, EPOCH);
  const outbox = new PendingMutationStore(memento() as never, USER, EPOCH);
  const mutator = new SyncMutator({
    userId: USER, keyEpoch: EPOCH, entities, mapStore, outbox,
    dek: () => DEK, signSeed: () => new Uint8Array(32),
  });
  return { store, entities, mapStore, outbox, mutator };
}

/** 另一端（另一设备）：独立存储/实体/映射，同 userId/keyEpoch。 */
function peer(): { store: ConnectionStore; entities: EntityStore; mapStore: RecordMapStore; ctx: ApplyContext } {
  const store = new ConnectionStore(memento() as never, secrets);
  const entities = new EntityStore(store);
  const mapStore = new RecordMapStore(memento() as never, USER, EPOCH);
  const ctx: ApplyContext = {
    entities, mapStore,
    unresolved: new UnresolvedRefStore(memento() as never, USER, EPOCH),
    uniqueId: (type) => `x-${type}-${Math.random().toString(36).slice(2)}`,
  };
  return { store, entities, mapStore, ctx };
}

/** 解出 put mutation 的有效载荷（跨设备 feed 到达即密文）。 */
function decryptPut(outbox: PendingMutationStore, recordId: string, version: string): unknown {
  const mutation = outbox.list().find((m) => m.action === 'record.put' && m.recordId === recordId);
  if (!mutation || mutation.action !== 'record.put') throw new Error('put mutation missing ciphertext');
  const plaintext = openRecord(
    DEK,
    Buffer.from(mutation.nonce, 'base64url'),
    Buffer.from(mutation.ciphertext, 'base64url'),
    Buffer.from(mutation.tag, 'base64url'),
    { userId: USER, keyEpoch: EPOCH, recordId, recordVersion: version },
  );
  return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

describe('删除→重新添加 生命周期（连接 / 分组 / 查询 / 文件夹）', () => {
  it('连接：删→确认→重加→另一端收敛（旧删/新活）', async () => {
    const w = world();
    const recordId = 'A'.repeat(22);
    const connA: SavedConnection = { id: 'c-a', name: 'a', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u' } as SavedConnection;
    await w.store.save(connA);
    await w.mapStore.put(recordId, { type: 'connection', localId: 'c-a', recordVersion: '1', revision: 0, status: 'confirmed' });

    await w.store.remove('c-a');
    await w.mutator.reconcile();
    expect(w.outbox.list().some((m) => m.action === 'record.delete' && m.recordId === recordId)).toBe(true);
    await w.mapStore.deleteByRef({ type: 'connection', localId: 'c-a' });

    const connB: SavedConnection = { id: 'c-b', name: 'b', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u' } as SavedConnection;
    await w.store.save(connB);
    await w.mutator.reconcile();
    const put = w.outbox.list().find((m) => m.action === 'record.put');
    expect(put).toBeTruthy();
    expect(put?.recordId).not.toBe(recordId);

    const p = peer();
    await p.entities.save({ type: 'connection', localId: 'c-a' }, { ...connA, updateTime: 1 }, 'sync');
    await p.mapStore.put(recordId, { type: 'connection', localId: 'c-a', recordVersion: '1', revision: 1, status: 'confirmed' });
    await applyRecord({ recordId, version: '2', tombstone: true, force: true }, p.ctx);
    const payload = decryptPut(w.outbox, put!.recordId, '1') as Record<string, unknown>;
    await applyRecord({ recordId: put!.recordId, version: '1', tombstone: false, payload, force: true }, p.ctx);
    expect(p.store.get('c-a')).toBeUndefined();
    const alive = p.store.listForSync().filter((c) => !c.deleted);
    expect(alive).toHaveLength(1);
    expect(alive[0].name).toBe('b');
  });

  it('分组：删→确认→重加→另一端收敛', async () => {
    const w = world();
    const recordId = 'B'.repeat(22);
    await w.store.addGroupRaw('g-a', 'Group A');
    await w.mapStore.put(recordId, { type: 'group', localId: 'g-a', recordVersion: '1', revision: 0, status: 'confirmed' });

    await w.store.removeGroup('g-a');
    await w.mutator.reconcile();
    expect(w.outbox.list().some((m) => m.action === 'record.delete' && m.recordId === recordId)).toBe(true);
    await w.mapStore.deleteByRef({ type: 'group', localId: 'g-a' });

    await w.store.addGroupRaw('g-b', 'Group B');
    await w.mutator.reconcile();
    const put = w.outbox.list().find((m) => m.action === 'record.put');
    expect(put).toBeTruthy();

    const p = peer();
    await p.entities.save({ type: 'group', localId: 'g-a' }, { id: 'g-a', name: 'Group A', updateTime: 1 }, 'sync');
    await p.mapStore.put(recordId, { type: 'group', localId: 'g-a', recordVersion: '1', revision: 1, status: 'confirmed' });
    await applyRecord({ recordId, version: '2', tombstone: true, force: true }, p.ctx);
    const payload = decryptPut(w.outbox, put!.recordId, '1') as Record<string, unknown>;
    await applyRecord({ recordId: put!.recordId, version: '1', tombstone: false, payload, force: true }, p.ctx);
    expect(p.store.getGroupById('g-a')?.deleted).toBe(true);
    const alive = p.store.listGroupsForSync().filter((g) => !g.deleted);
    expect(alive).toHaveLength(1);
    expect(alive[0].name).toBe('Group B');
  });

  it('查询：删→重加产生新 record put（不复用/不丢失）', async () => {
    const w = world();
    const recordId = 'C'.repeat(22);
    const qid = await w.store.saveQuery({ name: 'q', sql: 'select 1', connId: 'c' });
    await w.mapStore.put(recordId, { type: 'query', localId: qid, recordVersion: '1', revision: 0, status: 'confirmed' });

    await w.store.removeQuery(qid);
    await w.mutator.reconcile();
    expect(w.outbox.list().some((m) => m.action === 'record.delete' && m.recordId === recordId)).toBe(true);
    await w.mapStore.deleteByRef({ type: 'query', localId: qid });

    await w.store.saveQuery({ name: 'q2', sql: 'select 2', connId: 'c' });
    await w.mutator.reconcile();
    const puts = w.outbox.list().filter((m) => m.action === 'record.put');
    expect(puts).toHaveLength(1);
    expect(decryptPut(w.outbox, puts[0]!.recordId, '1')).toMatchObject({ type: 'query' });
  });

  it('文件夹：删→重加产生新 record put', async () => {
    const w = world();
    const recordId = 'D'.repeat(22);
    const fid = await w.store.addQueryFolder('F', 'c-c');
    await w.mapStore.put(recordId, { type: 'queryFolder', localId: fid, recordVersion: '1', revision: 0, status: 'confirmed' });

    await w.store.removeQueryFolder(fid);
    await w.mutator.reconcile();
    expect(w.outbox.list().some((m) => m.action === 'record.delete' && m.recordId === recordId)).toBe(true);
    await w.mapStore.deleteByRef({ type: 'queryFolder', localId: fid });

    await w.store.addQueryFolder('F2', 'c-c');
    await w.mutator.reconcile();
    const puts = w.outbox.list().filter((m) => m.action === 'record.put');
    expect(puts).toHaveLength(1);
    expect(decryptPut(w.outbox, puts[0]!.recordId, '1')).toMatchObject({ type: 'queryFolder' });
  });
});