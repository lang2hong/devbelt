import { describe, expect, it } from 'vitest';
import { ConnectionStore } from '../src/connection/connectionStore.js';
import { applyRecord } from '../src/sync/e2e/applyRecords.js';
import { RecordMapStore } from '../src/sync/e2e/recordMapStore.js';
import { EntityStore, UnresolvedRefStore } from '../src/sync/e2e/entityStore.js';

/**
 * 回归：group / queryFolder / query 的 updateTime 不随同步 payload 传输，
 * 必须由本地 store 在写入时打点。此前 `upsert*` 原样写入导致 applyRecords 的
 * `hasUpdateTime` 守卫抛错 —— 一条这类记录会让整页同步 error 且不推进游标。
 */
function memento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    async update(k: string, v: unknown) { m.set(k, v); },
  };
}

const secrets = {
  async get() { return undefined; },
  async store() { /* noop */ },
  async delete() { /* noop */ },
};

function setup() {
  const store = new ConnectionStore(memento() as never, secrets);
  const entities = new EntityStore(store);
  let n = 0;
  const ctx = {
    entities,
    mapStore: new RecordMapStore(memento() as never, '7', '1'),
    unresolved: new UnresolvedRefStore(memento() as never, '7', '1'),
    uniqueId: () => `x-${++n}`,
  };
  return { store, ctx };
}

describe('同步实体写入回报 updateTime', () => {
  it('applyRecord 写入 group/queryFolder/query 不再因缺 updateTime 抛错', async () => {
    const { ctx } = setup();
    await expect(applyRecord(
      { recordId: 'G'.repeat(22), version: '1', tombstone: false, payload: { type: 'group', name: 'Root' } }, ctx,
    )).resolves.toMatchObject({ disposition: 'created' });
    await expect(applyRecord(
      { recordId: 'F'.repeat(22), version: '1', tombstone: false, payload: { type: 'queryFolder', name: 'F', connId: undefined } }, ctx,
    )).resolves.toMatchObject({ disposition: 'created' });
    await expect(applyRecord(
      { recordId: 'Q'.repeat(22), version: '1', tombstone: false, payload: { type: 'query', name: 'Q', sql: 'SELECT 1', connId: undefined, folderId: undefined } }, ctx,
    )).resolves.toMatchObject({ disposition: 'created' });
  });

  it('store.upsert* 写入后 getById 的 updateTime 为数字', async () => {
    const { store } = setup();
    await store.upsertGroup({ id: 'g1', name: 'G' } as never);
    await store.upsertFolder({ id: 'f1', name: 'F', connId: 'c1' } as never);
    await store.upsertQuery({ id: 'q1', name: 'Q', sql: 'S', connId: 'c1' } as never);
    expect(typeof store.getGroupById('g1')?.updateTime).toBe('number');
    expect(typeof store.getFolderById('f1')?.updateTime).toBe('number');
    expect(typeof store.getQueryById('q1')?.updateTime).toBe('number');
  });
});