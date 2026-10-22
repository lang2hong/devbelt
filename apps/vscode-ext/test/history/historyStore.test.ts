import { describe, it, expect } from 'vitest';
import { HistoryStore, QueryHistoryEntry, clampHistoryLimit } from '../../src/history/historyStore';

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

  it('uses the configured retention limit', async () => {
    let limit = 20;
    const store = new HistoryStore(makeMemento(), () => limit);
    for (let i = 0; i < 30; i++) await store.add({ sql: `q${i}`, connection: 'c', costTime: i });
    expect(store.list()).toHaveLength(20);
    expect(store.list()[0].sql).toBe('q29');

    limit = 10;
    await store.add({ sql: 'q30', connection: 'c', costTime: 0 });
    expect(store.list()).toHaveLength(10);
  });

  it('clamps the retention limit to 10–1000 and falls back on bad values', () => {
    expect(clampHistoryLimit(5)).toBe(10);
    expect(clampHistoryLimit(5000)).toBe(1000);
    expect(clampHistoryLimit(250.7)).toBe(250);
    expect(clampHistoryLimit(undefined)).toBe(100);
    expect(clampHistoryLimit('300')).toBe(100);
  });

  it('stores the failed flag', async () => {
    const store = new HistoryStore(makeMemento());
    await store.add({ sql: 'SELECT x', connection: 'c', costTime: 1, failed: true });
    expect(store.list()[0].failed).toBe(true);
  });
});
