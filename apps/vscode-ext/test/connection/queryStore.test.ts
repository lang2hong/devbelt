import { describe, expect, it } from 'vitest';
import { QueryStore } from '@devbelt/db-host/connection/queryStore';

function createMemento() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

describe('QueryStore', () => {
  it('updates only the matching saved query', async () => {
    const store = new QueryStore(createMemento());
    const queryId = await store.saveQuery({ name: 'Customers', sql: 'SELECT * FROM customers', connId: 'primary', database: 'app' });
    await store.saveQuery({ name: 'Orders', sql: 'SELECT * FROM orders', connId: 'primary', database: 'app' });

    await store.updateQuery(queryId, { sql: 'SELECT id FROM customers' });

    const queries = store.getQueries('primary', 'app');
    expect(queries.find((query) => query.id === queryId)?.sql).toBe('SELECT id FROM customers');
    expect(queries.find((query) => query.name === 'Orders')?.sql).toBe('SELECT * FROM orders');
  });

  it('scopes saved queries into folders and moves them back to root on folder delete', async () => {
    const store = new QueryStore(createMemento());
    const folderId = await store.addQueryFolder('Reports', 'primary');
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
    const store = new QueryStore(createMemento());
    const folderId = await store.addQueryFolder('Old', 'primary');
    await store.saveQuery({ name: 'Daily', sql: 'SELECT 1', connId: 'primary', database: 'app', folderId });

    await store.renameQueryFolder(folderId, 'New');

    expect(store.getQueryFolders()[0]).toMatchObject({ id: folderId, name: 'New' });
    expect(store.getQueriesInFolder('primary', 'app', folderId)).toHaveLength(1);
  });

  it('removes a saved query by id', async () => {
    const store = new QueryStore(createMemento());
    const queryId = await store.saveQuery({ name: 'A', sql: 'SELECT 1', connId: 'primary', database: 'app' });

    await store.removeQuery(queryId);

    expect(store.getQueries('primary', 'app')).toHaveLength(0);
  });

  it('replaceAll replaces local queries and folders entirely (use remote)', async () => {
    const store = new QueryStore(createMemento());
    await store.saveQuery({ name: 'Local', sql: 'SELECT 1', connId: 'primary', database: 'app' });
    await store.addQueryFolder('LocalFolder', 'primary');

    await store.replaceAll({
      queries: [{ id: 'r1', name: 'Remote', sql: 'SELECT 2', connId: 'primary', database: 'app', createTime: 1, updateTime: 1, deleted: false }],
      folders: [{ id: 'rf1', name: 'RemoteFolder', connId: 'primary', createTime: 1, updateTime: 1, deleted: false }],
    });

    const data = store.getSyncData();
    expect(data.queries).toEqual([expect.objectContaining({ id: 'r1' })]);
    expect(data.folders).toEqual([expect.objectContaining({ id: 'rf1' })]);
  });
});