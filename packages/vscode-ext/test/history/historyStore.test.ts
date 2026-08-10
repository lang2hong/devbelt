import { describe, it, expect } from 'vitest';
import { HistoryStore, QueryHistoryEntry } from '../../src/history/historyStore';

function makeMemento(initial: QueryHistoryEntry[] = []) {
  let data: QueryHistoryEntry[] = initial;
  return {
    get: <T>(_key: string): T | undefined => data as T,
    update: async (_key: string, value: any): Promise<void> => { data = value; },
  };
}

describe('HistoryStore', () => {
  it('stores connectionId and database on new entries', async () => {
    const memento = makeMemento();
    const store = new HistoryStore(memento);
    await store.add({ sql: 'SELECT 1', connection: 'local', connectionId: 'c1', database: 'app', costTime: 5, rowCount: 1 });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].connectionId).toBe('c1');
    expect(list[0].database).toBe('app');
  });

  it('records entries without connectionId for backwards compatibility', async () => {
    const memento = makeMemento();
    const store = new HistoryStore(memento);
    await store.add({ sql: 'SELECT 2', connection: 'legacy', costTime: 3 });
    const list = store.list();
    expect(list[0].connection).toBe('legacy');
    expect(list[0].connectionId).toBeUndefined();
    expect(list[0].database).toBeUndefined();
  });

  it('reads legacy persisted entries that lack new fields', async () => {
    const legacy = [{ id: '1', sql: 'SELECT 3', connection: 'old', time: 100, costTime: 1 }];
    const memento = makeMemento(legacy);
    const store = new HistoryStore(memento);
    const list = store.list();
    expect(list[0].connectionId).toBeUndefined();
    expect(list[0].database).toBeUndefined();
    expect(list[0].sql).toBe('SELECT 3');
  });

  it('caps entries at MAX_ENTRIES', async () => {
    const memento = makeMemento();
    const store = new HistoryStore(memento);
    for (let i = 0; i < 150; i++) {
      await store.add({ sql: `q${i}`, connection: 'c', costTime: i });
    }
    expect(store.list().length).toBe(100);
  });
});