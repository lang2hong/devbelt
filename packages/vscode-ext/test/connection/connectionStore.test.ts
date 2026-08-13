import { describe, expect, it } from 'vitest';
import { ConnectionStore, type ConnectionTreeData, type SavedConnection } from '../../src/connection/connectionStore';

function createMemento(data: ConnectionTreeData) {
  const values = new Map<string, unknown>([['dbclient.connectionsV2', data]]);
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

function createSecrets() {
  const values = new Map<string, string>();
  return {
    async get(key: string): Promise<string | undefined> { return values.get(key); },
    async store(key: string, value: string): Promise<void> { values.set(key, value); },
    async delete(key: string): Promise<void> { values.delete(key); },
  };
}

function conn(over: Partial<SavedConnection>): SavedConnection {
  return {
    id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
    host: 'localhost', port: 3306, user: 'root',
    ...over,
  } as SavedConnection;
}

describe('ConnectionStore sync model', () => {
  it('migrates legacy credentials to SecretStorage and includes them in sync payload', async () => {
    const memento = createMemento({ groups: [], connections: [conn({ password: 'db-secret', sshPassword: 'ssh-secret' })] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);

    await store.init();

    expect(memento.get<ConnectionTreeData>('dbclient.connectionsV2')!.connections[0]).not.toHaveProperty('password');
    expect(await secrets.get('dbclient.connection.primary.password')).toBe('db-secret');
    expect(store.get('primary')!.password).toBe('db-secret');

    const syncData = await store.getSyncData();
    expect(syncData.connections[0].password).toBe('db-secret');
    expect(syncData.connections[0].sshPassword).toBe('ssh-secret');
  });

  it('replaceAllMerge stores the remote password to SecretStorage when remote wins', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);

    await store.replaceAllMerge({
      groups: [],
      connections: [conn({ name: 'Remote', host: 'db.internal', user: 'app', password: 'remote-password', updateTime: 100 })],
    });

    expect(store.get('primary')!.password).toBe('remote-password');
    expect(await secrets.get('dbclient.connection.primary.password')).toBe('remote-password');
  });

  it('replaceAllMerge keeps the local connection when it is newer', async () => {
    const memento = createMemento({ groups: [], connections: [conn({ name: 'Local', host: 'db.internal', user: 'app', password: 'local-password', updateTime: 200 })] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.init();

    await store.replaceAllMerge({
      groups: [],
      connections: [conn({ name: 'Remote', host: 'db.internal', user: 'app', password: 'remote-password', updateTime: 100 })],
    });

    expect(store.get('primary')!.name).toBe('Local');
    expect(store.get('primary')!.password).toBe('local-password');
  });

  it('delete wins on merge: remote tombstone hides the local connection', async () => {
    const memento = createMemento({ groups: [], connections: [conn({ name: 'Primary', host: 'db.internal', user: 'app', password: 'local-password', updateTime: 200 })] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.init();

    await store.replaceAllMerge({
      groups: [],
      connections: [conn({ name: 'Primary', host: 'db.internal', user: 'app', deleted: true, updateTime: 100 })],
    });

    expect(store.list()).toHaveLength(0);
    expect(store.get('primary')).toBeUndefined();
  });

  it('materializes a saved password back into the connection', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.save(conn({ password: 'db-secret' }));

    expect(store.get('primary')!.password).toBe('db-secret');
    expect(store.list()[0].password).toBe('db-secret');
  });

  it('does not overwrite an existing password when saving an empty value', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.save(conn({ password: 'db-secret' }));

    await store.save(conn({ password: '' }));

    expect(await secrets.get('dbclient.connection.primary.password')).toBe('db-secret');
    expect(store.get('primary')!.password).toBe('db-secret');
  });
});
