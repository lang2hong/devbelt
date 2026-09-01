import { describe, expect, it, vi } from 'vitest';
import { Encryption } from '../../src/sync/encryption';
import { SyncManager, SyncLocalDirtyError, stableStringify } from '../../src/sync/syncManager';
import type { SyncPayload } from '../../src/sync/syncPayload';
import type { ConnectionTreeData, SavedConnection } from '../../src/connection/connectionStore';
import type { QueryFolder } from '../../src/connection/queryStore';
import type { SavedQuery } from '@db-client/core';
import type { QueryHistoryEntry } from '../../src/history/historyStore';

function makeHashStore() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => { values.set(key, value); },
  };
}

const sampleConn: SavedConnection = {
  id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
  host: 'localhost', port: 3306, user: 'root', password: 'db-secret', updateTime: 100,
} as SavedConnection;

const sampleQuery: SavedQuery = {
  id: 'q1', name: 'Q', sql: 'SELECT 1', connId: 'primary', database: 'app',
  createTime: 1, updateTime: 1, deleted: false,
};

const sampleFolder: QueryFolder = { id: 'qf1', name: 'F', createTime: 1, updateTime: 1, deleted: false };

const sampleHistory: QueryHistoryEntry = {
  id: 'h1', sql: 'SELECT 1', connection: 'Primary', connectionId: 'primary', database: 'app',
  time: 1, costTime: 5, rowCount: 1,
};

function makePayload(): SyncPayload {
  return {
    version: 1,
    groups: [{ id: 'g1', name: 'G', createTime: 1, updateTime: 1, deleted: false }],
    connections: [sampleConn],
    queries: [sampleQuery],
    queryFolders: [sampleFolder],
    history: [sampleHistory],
  };
}

function makeStore(payload: SyncPayload) {
  return {
    getSyncData: vi.fn(async (): Promise<ConnectionTreeData> => ({ groups: payload.groups, connections: payload.connections })),
    getConnectionMeta: vi.fn(() => []),
    replaceAllMerge: vi.fn(async (_tree: ConnectionTreeData) => {}),
    replaceAll: vi.fn(async (_tree: ConnectionTreeData) => {}),
    getQueriesForSync: vi.fn(() => ({ queries: payload.queries, folders: payload.queryFolders })),
    replaceQueriesForSync: vi.fn(async (_data: { queries: SavedQuery[]; folders: QueryFolder[] }) => {}),
    replaceQueriesForSyncAll: vi.fn(async (_data: { queries: SavedQuery[]; folders: QueryFolder[] }) => {}),
  };
}

function makeHistory(payload: SyncPayload) {
  return {
    getSyncData: vi.fn(() => payload.history),
    replaceAllMerge: vi.fn(async (_remote: QueryHistoryEntry[]) => {}),
  };
}

/** 分节 mock client：fetchSections / pushSection */
function makeAuth() {
  const pushed: { section: string; data: string; baseVersion: number }[] = [];
  const remote = new Map<string, { encryptedData: string; version: number }>();
  return {
    pushed,
    getCachedEntitlement() { return undefined; },
    /** 将完整 payload 分节加密后置入远端 */
    setRemote(payload: SyncPayload, masterPassword: string, startVersion = 0) {
      const sections: Array<[string, unknown]> = [
        ['groups', payload.groups],
        ['connections', payload.connections],
        ['queries', payload.queries],
        ['folders', payload.queryFolders],
        ['history', payload.history],
      ];
      let v = startVersion;
      for (const [section, data] of sections) {
        v++;
        remote.set(section, { encryptedData: Encryption.encrypt(data, masterPassword), version: v });
      }
    },
    client: {
      async fetchSections(section?: string) {
        if (section) {
          const s = remote.get(section);
          return { sections: s ? [{ section, ...s, updateTime: '' }] : [] };
        }
        return {
          sections: Array.from(remote.entries()).map(([section, v]) => ({ section, ...v, updateTime: '' })),
        };
      },
      async pushSection(section: string, data: string, baseVersion: number) {
        pushed.push({ section, data, baseVersion });
        const cur = remote.get(section);
        const version = (cur ? cur.version : 0) + 1;
        remote.set(section, { encryptedData: data, version });
        return { version };
      },
    },
  };
}

const masterStore = { async get() { return undefined as string | undefined; }, async store() {}, async clear() {} };

describe('SyncManager', () => {
  it('push encrypts each section (including passwords) and records the sync hash', async () => {
    const payload = makePayload();
    const auth = makeAuth();
    const store = makeStore(payload);
    const history = makeHistory(payload);
    const hashStore = makeHashStore();
    const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

    await sync.push('master-pass');

    expect(auth.pushed).toHaveLength(5);
    const connPush = auth.pushed.find((p) => p.section === 'connections')!;
    expect(connPush.data).not.toContain('db-secret');
    const decrypted = Encryption.decrypt(connPush.data, 'master-pass') as SavedConnection[];
    expect(decrypted[0].password).toBe('db-secret');
    const queryPush = auth.pushed.find((p) => p.section === 'queries')!;
    expect((Encryption.decrypt(queryPush.data, 'master-pass') as SavedQuery[])[0].id).toBe('q1');
    const folderPush = auth.pushed.find((p) => p.section === 'folders')!;
    expect((Encryption.decrypt(folderPush.data, 'master-pass') as QueryFolder[])[0].id).toBe('qf1');
    const historyPush = auth.pushed.find((p) => p.section === 'history')!;
    expect((Encryption.decrypt(historyPush.data, 'master-pass') as QueryHistoryEntry[])[0].id).toBe('h1');
    expect(hashStore.get<string>('dbclient.sync.lastHash')).toBeTruthy();
  });

  it('pull decrypts each section and dispatches to merge', async () => {
    const payload = makePayload();
    const auth = makeAuth();
    auth.setRemote(payload, 'master-pass');
    const store = makeStore(makePayload());
    const history = makeHistory(makePayload());
    const hashStore = makeHashStore();
    const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

    await sync.pull('master-pass');

    expect(store.replaceAllMerge).toHaveBeenCalledWith({ groups: payload.groups, connections: payload.connections });
    expect(store.replaceQueriesForSync).toHaveBeenCalledWith({ queries: payload.queries, folders: payload.queryFolders });
    expect(history.replaceAllMerge).toHaveBeenCalledWith(payload.history);
  });

  it('pull without force throws when local has unpushed changes', async () => {
    const payload = makePayload();
    const auth = makeAuth();
    const store = makeStore(payload);
    const history = makeHistory(payload);
    const hashStore = makeHashStore();
    await hashStore.update('dbclient.sync.lastHash', 'stale-hash');

    const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

    await expect(sync.pull('master-pass')).rejects.toBeInstanceOf(SyncLocalDirtyError);
  });

  it('pull with force merges despite local being dirty', async () => {
    const payload = makePayload();
    const auth = makeAuth();
    auth.setRemote(payload, 'master-pass');
    const store = makeStore(makePayload());
    const history = makeHistory(makePayload());
    const hashStore = makeHashStore();
    await hashStore.update('dbclient.sync.lastHash', 'stale-hash');
    const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

    await sync.pull('master-pass', true);

    expect(store.replaceAllMerge).toHaveBeenCalled();
  });

  describe('applyPreviewedPull 策略', () => {
    async function setup() {
      const payload = makePayload();
      const auth = makeAuth();
      auth.setRemote(payload, 'master-pass');
      const store = makeStore(makePayload());
      const history = makeHistory(makePayload());
      const hashStore = makeHashStore();
      const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);
      await sync.previewPull('master-pass');
      return { store, history, sync };
    }

    it('merge 走 replaceAllMerge / replaceQueriesForSync', async () => {
      const { store, history, sync } = await setup();
      await sync.applyPreviewedPull('merge');
      expect(store.replaceAllMerge).toHaveBeenCalled();
      expect(store.replaceQueriesForSync).toHaveBeenCalled();
      expect(store.replaceAll).not.toHaveBeenCalled();
      expect(store.replaceQueriesForSyncAll).not.toHaveBeenCalled();
      expect(history.replaceAllMerge).toHaveBeenCalled();
    });

    it('remote 走 replaceAll / replaceQueriesForSyncAll', async () => {
      const { store, history, sync } = await setup();
      await sync.applyPreviewedPull('remote');
      expect(store.replaceAll).toHaveBeenCalled();
      expect(store.replaceQueriesForSyncAll).toHaveBeenCalled();
      expect(store.replaceAllMerge).not.toHaveBeenCalled();
      expect(store.replaceQueriesForSync).not.toHaveBeenCalled();
      expect(history.replaceAllMerge).toHaveBeenCalled();
    });

    it('local 不写任何 store/history（保留本地）', async () => {
      const { store, history, sync } = await setup();
      await sync.applyPreviewedPull('local');
      expect(store.replaceAllMerge).not.toHaveBeenCalled();
      expect(store.replaceAll).not.toHaveBeenCalled();
      expect(store.replaceQueriesForSync).not.toHaveBeenCalled();
      expect(store.replaceQueriesForSyncAll).not.toHaveBeenCalled();
      expect(history.replaceAllMerge).not.toHaveBeenCalled();
    });
  });

  it('isLocalDirty is false right after a push (hash up to date)', async () => {
    const payload = makePayload();
    const auth = makeAuth();
    const store = makeStore(payload);
    const history = makeHistory(payload);
    const hashStore = makeHashStore();
    const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

    await sync.push('master-pass');
    expect(await sync.isLocalDirty()).toBe(false);
  });

  /**
   * 回归：指纹必须对**嵌套字段**敏感。
   * 曾用 `JSON.stringify(payload, Object.keys(payload).sort())`，第二参数被当成
   * replacer 白名单，嵌套字段全被剔除 → 改连接名/主机/密码后 isLocalDirty 恒 false，
   * pull 会静默覆盖本地未推送的改动。
   */
  describe('isLocalDirty 对嵌套内容变更敏感', () => {
    const nestedEdits: Array<[string, (c: SavedConnection) => void]> = [
      ['连接名', (c) => { c.name = 'Renamed'; }],
      ['主机', (c) => { c.host = '10.0.0.1'; }],
      ['密码', (c) => { c.password = 'rotated-secret'; }],
      ['端口', (c) => { c.port = 3307; }],
    ];

    for (const [label, mutate] of nestedEdits) {
      it(`改${label}后判定为脏`, async () => {
        const payload = makePayload();
        const auth = makeAuth();
        const store = makeStore(payload);
        const history = makeHistory(payload);
        const hashStore = makeHashStore();
        const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

        await sync.push('master-pass');
        expect(await sync.isLocalDirty()).toBe(false);

        mutate(payload.connections[0]);
        expect(await sync.isLocalDirty()).toBe(true);
      });
    }

    it('改查询 SQL 后判定为脏', async () => {
      const payload = makePayload();
      const auth = makeAuth();
      const store = makeStore(payload);
      const history = makeHistory(payload);
      const hashStore = makeHashStore();
      const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

      await sync.push('master-pass');
      payload.queries[0].sql = 'SELECT 2';
      expect(await sync.isLocalDirty()).toBe(true);
    });

    it('新增连接后判定为脏', async () => {
      const payload = makePayload();
      const auth = makeAuth();
      const store = makeStore(payload);
      const history = makeHistory(payload);
      const hashStore = makeHashStore();
      const sync = new SyncManager(auth as any, store as any, history as any, hashStore as any, masterStore as any);

      await sync.push('master-pass');
      payload.connections.push({ ...sampleConn, id: 'second', name: 'Second' });
      expect(await sync.isLocalDirty()).toBe(true);
    });
  });
});

describe('stableStringify', () => {
  it('键序无关：同内容不同键序产出相同字符串', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('递归进入嵌套对象与数组', () => {
    const a = stableStringify({ list: [{ y: 1, x: 2 }] });
    const b = stableStringify({ list: [{ x: 2, y: 1 }] });
    expect(a).toBe(b);
    expect(a).toBe('{"list":[{"x":2,"y":1}]}');
  });

  it('数组顺序敏感', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('嵌套字段变化必然改变输出', () => {
    const base = { connections: [{ id: 'a', host: 'localhost', password: 'p1' }] };
    const changed = { connections: [{ id: 'a', host: 'localhost', password: 'p2' }] };
    expect(stableStringify(base)).not.toBe(stableStringify(changed));
  });

  it('处理 null / 原始值 / undefined 键', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(1)).toBe('1');
    expect(stableStringify('s')).toBe('"s"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify(undefined)).toBe('null');
  });
});
