import { describe, expect, it, vi } from 'vitest';
import { SyncSessionFactory } from '../../src/sync/sessionFactory';
import { DekStore } from '../../src/sync/crypto/keyStore';
import type { PersonalSyncClient } from '../../src/sync/e2e/client';
import type { ConnectionStore } from '../../src/connection/connectionStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function makeDekStore() {
  return new DekStore({
    get: vi.fn(async () => undefined),
    store: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as never);
}

function makeStore(): ConnectionStore {
  return {
    onChanged: () => ({ dispose: () => {} }),
    listForSync: () => [],
    listGroupsForSync: () => [],
    listFoldersForSync: () => [],
    listQueriesForSync: () => [],
    get: () => undefined,
    getGroupById: () => undefined,
    getFolderById: () => undefined,
    getQueryById: () => undefined,
    save: async () => {},
    remove: async () => {},
    upsertGroup: async () => {},
    upsertFolder: async () => {},
    upsertQuery: async () => {},
    removeGroup: async () => {},
    removeQueryFolder: async () => {},
    removeQuery: async () => {},
  } as unknown as ConnectionStore;
}

describe('SyncSessionFactory', () => {
  function setup(userId?: string) {
    const createClient = vi.fn(() => ({} as PersonalSyncClient));
    const factory = new SyncSessionFactory({
      connectionStore: makeStore(),
      dekStore: makeDekStore(),
      memento: makeMemento(),
      getUserId: async () => userId,
      createClient,
    });
    return { factory, createClient };
  }

  it('未登录 → ensureSession 返回 undefined，不建 session 不建 client', async () => {
    const { factory, createClient } = setup(undefined);
    expect(await factory.ensureSession()).toBeUndefined();
    expect(factory.current).toBeUndefined();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('登录 → 懒建 session，复用同一实例（不重复建 client）', async () => {
    const { factory, createClient } = setup('7');
    const s1 = await factory.ensureSession();
    const s2 = await factory.ensureSession();
    expect(s1).toBeDefined();
    expect(s1).toBe(s2);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('换号 → 丢弃旧 session 重建', async () => {
    let uid = '1';
    const createClient = vi.fn(() => ({} as PersonalSyncClient));
    const factory = new SyncSessionFactory({
      connectionStore: makeStore(),
      dekStore: makeDekStore(),
      memento: makeMemento(),
      getUserId: async () => uid,
      createClient,
    });
    const s1 = await factory.ensureSession();
    expect(s1!.uid).toBe('1');
    uid = '2';
    const s2 = await factory.ensureSession();
    expect(s2!.uid).toBe('2');
    expect(s2).not.toBe(s1);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('invalidate 丢弃 session，再次 ensure 重建', async () => {
    const { factory, createClient } = setup('7');
    const s1 = await factory.ensureSession();
    expect(s1).toBeDefined();
    factory.invalidate();
    expect(factory.current).toBeUndefined();
    const s2 = await factory.ensureSession();
    expect(s2).not.toBe(s1);
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});