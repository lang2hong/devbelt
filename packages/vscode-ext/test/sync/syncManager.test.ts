import { describe, expect, it, vi } from 'vitest';
import { Encryption } from '../../src/sync/encryption';
import { SyncManager, SyncLocalDirtyError } from '../../src/sync/syncManager';
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
    replaceAllMerge: vi.fn(async (_tree: ConnectionTreeData) => {}),
    getQueriesForSync: vi.fn(() => ({ queries: payload.queries, folders: payload.queryFolders })),
    replaceQueriesForSync: vi.fn(async (_data: { queries: SavedQuery[]; folders: QueryFolder[] }) => {}),
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
});
