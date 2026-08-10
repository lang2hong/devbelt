import { describe, expect, it } from 'vitest';
import { ConnectionStore, type ConnectionTreeData } from '../../src/connection/connectionStore';

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

describe('ConnectionStore credential handling', () => {
  it('migrates legacy credentials to SecretStorage and excludes them from sync', async () => {
    const memento = createMemento({
      groups: [],
      connections: [{
        id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
        host: 'localhost', port: 3306, user: 'root', password: 'db-secret',
        sshPassword: 'ssh-secret',
      }],
    });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);

    await store.init();

    expect(memento.get<ConnectionTreeData>('dbclient.connectionsV2')!.connections[0]).not.toHaveProperty('password');
    expect(await secrets.get('dbclient.connection.primary.password')).toBe('db-secret');
    expect(store.get('primary')!.password).toBe('db-secret');
    expect(store.getSyncTreeData().connections[0]).not.toHaveProperty('sshPassword');
  });

  it('updates only the matching saved query', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const store = new ConnectionStore(memento, createSecrets() as any);
    const queryId = await store.saveQuery({ name: 'Customers', sql: 'SELECT * FROM customers', connId: 'primary', database: 'app' });
    await store.saveQuery({ name: 'Orders', sql: 'SELECT * FROM orders', connId: 'primary', database: 'app' });

    await store.updateQuery(queryId, { sql: 'SELECT id FROM customers' });

    const queries = store.getQueries('primary', 'app');
    expect(queries.find((query) => query.id === queryId)?.sql).toBe('SELECT id FROM customers');
    expect(queries.find((query) => query.name === 'Orders')?.sql).toBe('SELECT * FROM orders');
  });

  it('scopes saved queries into folders and moves them back to root on folder delete', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const store = new ConnectionStore(memento, createSecrets() as any);
    const folderId = await store.addQueryFolder('Reports');
    await store.saveQuery({ name: 'Daily', sql: 'SELECT 1', connId: 'primary', database: 'app', folderId });
    await store.saveQuery({ name: 'Root', sql: 'SELECT 2', connId: 'primary', database: 'app' });

    expect(store.getQueriesInFolder('primary', 'app', folderId)).toHaveLength(1);
    expect(store.getQueriesInFolder('primary', 'app')).toHaveLength(1);
    expect(store.getQueryFolders()).toHaveLength(1);

    await store.removeQueryFolder(folderId);

    expect(store.getQueryFolders()).toHaveLength(0);
    expect(store.getQueriesInFolder('primary', 'app')).toHaveLength(2);
  });

  it('renames a query folder without losing its queries', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const store = new ConnectionStore(memento, createSecrets() as any);
    const folderId = await store.addQueryFolder('Old');
    await store.saveQuery({ name: 'Daily', sql: 'SELECT 1', connId: 'primary', database: 'app', folderId });

    await store.renameQueryFolder(folderId, 'New');

    expect(store.getQueryFolders()[0]).toMatchObject({ id: folderId, name: 'New' });
    expect(store.getQueriesInFolder('primary', 'app', folderId)).toHaveLength(1);
  });

  it('clears local credentials when synchronized connection targets change', async () => {
    const memento = createMemento({
      groups: [],
      connections: [{
        id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
        host: 'db.internal', port: 3306, user: 'app', password: 'legacy-password',
      }],
    });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.init();

    await store.replaceAll({
      groups: [],
      connections: [{
        id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
        host: 'replica.internal', port: 3306, user: 'app', password: 'remote-password',
      }],
    });

    expect(store.get('primary')!.password).toBeUndefined();
    expect(await secrets.get('dbclient.connection.primary.password')).toBeUndefined();
  });

  it('preserves local credentials when synchronized connection targets match', async () => {
    const memento = createMemento({
      groups: [],
      connections: [{
        id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
        host: 'db.internal', port: 3306, user: 'app', password: 'legacy-password',
      }],
    });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.init();

    await store.replaceAll({
      groups: [],
      connections: [{
        id: 'primary', name: 'Renamed', dbType: 'MYSQL' as any,
        host: 'db.internal', port: 3306, user: 'app',
      }],
    });

    expect(store.get('primary')!.password).toBe('legacy-password');
  });

  it('materializes a saved password back into the connection', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.save({
      id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
      host: 'localhost', port: 3306, user: 'root', password: 'db-secret',
    });

    expect(store.get('primary')!.password).toBe('db-secret');
    expect(store.list()[0].password).toBe('db-secret');
  });

  it('does not overwrite an existing password when saving an empty value', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.save({
      id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
      host: 'localhost', port: 3306, user: 'root', password: 'db-secret',
    });

    await store.save({
      id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
      host: 'localhost', port: 3306, user: 'root', password: '',
    });

    expect(await secrets.get('dbclient.connection.primary.password')).toBe('db-secret');
    expect(store.get('primary')!.password).toBe('db-secret');
  });
});
