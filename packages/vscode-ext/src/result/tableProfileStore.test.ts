import { describe, it, expect } from 'vitest';
import { TableProfileStore } from './tableProfileStore';

function makeMemento(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initial };
  return {
    get: <T>(key: string): T | undefined => data[key] as T,
    update: async (key: string, value: any): Promise<void> => { data[key] = value; },
  };
}

describe('TableProfileStore', () => {
  it('returns undefined for a table with no saved profile', () => {
    const store = new TableProfileStore(makeMemento());
    expect(store.get('c1', 'app', 'users')).toBeUndefined();
  });

  it('saves and reads back table display preferences', async () => {
    const store = new TableProfileStore(makeMemento());
    await store.save('c1', 'app', 'users', {
      sortCol: 'id', sortDir: 'DESC', filterConditions: [{ column: 'name', op: 'contains', value: 'a' }], hiddenColumns: ['secret'],
      columnOrder: ['name', 'id'], columnWidths: { name: 280 },
    });
    const profile = store.get('c1', 'app', 'users');
    expect(profile?.sortCol).toBe('id');
    expect(profile?.sortDir).toBe('DESC');
    expect(profile?.filterConditions).toEqual([{ column: 'name', op: 'contains', value: 'a' }]);
    expect(profile?.hiddenColumns).toEqual(['secret']);
    expect(profile?.columnOrder).toEqual(['name', 'id']);
    expect(profile?.columnWidths).toEqual({ name: 280 });
  });

  it('merges successive saves instead of overwriting unrelated fields', async () => {
    const store = new TableProfileStore(makeMemento());
    await store.save('c1', 'app', 'users', { sortCol: 'id', sortDir: 'ASC' });
    await store.save('c1', 'app', 'users', { filterConditions: [{ column: 'name', op: 'eq', value: 'a' }] });
    const profile = store.get('c1', 'app', 'users');
    expect(profile?.sortCol).toBe('id');
    expect(profile?.filterConditions).toEqual([{ column: 'name', op: 'eq', value: 'a' }]);
  });

  it('isolates profiles by connection, database, and table', async () => {
    const store = new TableProfileStore(makeMemento());
    await store.save('c1', 'app', 'users', { sortCol: 'id' });
    await store.save('c2', 'app', 'users', { sortCol: 'name' });
    await store.save('c1', 'other', 'users', { sortCol: 'email' });
    await store.save('c1', 'app', 'orders', { sortCol: 'total' });

    expect(store.get('c1', 'app', 'users')?.sortCol).toBe('id');
    expect(store.get('c2', 'app', 'users')?.sortCol).toBe('name');
    expect(store.get('c1', 'other', 'users')?.sortCol).toBe('email');
    expect(store.get('c1', 'app', 'orders')?.sortCol).toBe('total');
  });

  it('treats undefined database distinctly but consistently', async () => {
    const store = new TableProfileStore(makeMemento());
    await store.save('c1', undefined, 'users', { sortCol: 'id' });
    expect(store.get('c1', undefined, 'users')?.sortCol).toBe('id');
  });

  it('removes only the requested table profile', async () => {
    const store = new TableProfileStore(makeMemento());
    await store.save('c1', 'app', 'users', { columnOrder: ['name', 'id'] });
    await store.save('c1', 'app', 'orders', { columnWidths: { total: 180 } });

    await store.remove('c1', 'app', 'users');

    expect(store.get('c1', 'app', 'users')).toBeUndefined();
    expect(store.get('c1', 'app', 'orders')?.columnWidths).toEqual({ total: 180 });
  });
});
