import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devkit/db-core';
import { ConnectionPathOverrideStore } from '../../src/connection/connectionPathOverrideStore';
import { validateConnectionPaths } from '../../src/connection/connectionPathValidator';
import type { SavedConnection } from '../../src/connection/connectionStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function conn(over: Partial<SavedConnection> = {}): SavedConnection {
  return { id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', ...over } as SavedConnection;
}

function accessWith(existing: string[]) {
  return async (path: string) => {
    if (!existing.includes(path)) throw new Error('ENOENT');
  };
}

describe('ConnectionPathOverrideStore', () => {
  it('set 为 merge，空串/空白等同 clearField（不持久化空值）', async () => {
    const store = new ConnectionPathOverrideStore(makeMemento());
    await store.set('c-1', { dbPath: '/a', caPath: '/ca' });
    await store.set('c-1', { dbPath: '/b' });
    expect(store.get('c-1')).toEqual({ dbPath: '/b', caPath: '/ca' });

    await store.set('c-1', { dbPath: '   ' });
    expect(store.get('c-1')).toEqual({ caPath: '/ca' });
  });

  it('clearField 与 clear', async () => {
    const store = new ConnectionPathOverrideStore(makeMemento());
    await store.set('c-1', { dbPath: '/a', connectionUrl: 'mysql://u' });
    await store.clearField('c-1', 'dbPath');
    expect(store.get('c-1')).toEqual({ connectionUrl: 'mysql://u' });
    await store.clear('c-1');
    expect(store.get('c-1')).toEqual({});
  });

  it('applyOverrides 覆盖优先，返回新对象且不改源 conn', async () => {
    const store = new ConnectionPathOverrideStore(makeMemento());
    await store.set('c-1', {
      dbPath: '/override.db',
      caPath: '/override.ca',
      sshPrivateKeyPath: '/override.key',
      connectionUrl: 'mysql://override',
      useConnectionString: true,
      sqliteCommand: '/usr/bin/sqlite3',
    });

    const c = conn({
      dbType: DatabaseType.SQLITE,
      dbPath: '/src.db',
      useSSL: true, caPath: '/src.ca',
      sshHost: 'ssh', sshPrivateKeyPath: '/src.key',
      connectionUrl: 'src-url', useConnectionString: false,
      sqliteCommand: '/src/sqlite3',
    });

    const e = store.applyOverrides(c);
    expect(e).not.toBe(c);
    expect(e.dbPath).toBe('/override.db');
    expect(e.caPath).toBe('/override.ca');
    expect(e.sshPrivateKeyPath).toBe('/override.key');
    expect(e.connectionUrl).toBe('mysql://override');
    expect(e.useConnectionString).toBe(true);
    expect(e.sqliteCommand).toBe('/usr/bin/sqlite3');

    // 源对象未被改写
    expect(c.dbPath).toBe('/src.db');
    expect(c.caPath).toBe('/src.ca');
    expect(c.connectionUrl).toBe('src-url');
  });

  it('applyOverrides 条件裁剪：不适用字段静默忽略', async () => {
    const store = new ConnectionPathOverrideStore(makeMemento());
    await store.set('c-1', { dbPath: '/override.db', caPath: '/ca' });
    // MySQL + 无 SSL：dbPath/caPath 覆盖均不适用
    const c = conn({ dbType: DatabaseType.MYSQL });
    const e = store.applyOverrides(c);
    expect(e.dbPath).toBeUndefined();
    expect(e.caPath).toBeUndefined();
  });

  it('allowlist 过滤：get 返回时丢弃非法字段', async () => {
    const m = makeMemento();
    await m.update('dbclient.connectionPathOverrides', {
      'c-1': { dbPath: '/ok', bogus: 42, dbType: 'PG', connectionUrl: '' },
    });
    const store = new ConnectionPathOverrideStore(m);
    expect(store.get('c-1')).toEqual({ dbPath: '/ok' });
  });

  it('覆盖补齐后有效配置通过 validateConnectionPaths，删除覆盖恢复源值', async () => {
    const store = new ConnectionPathOverrideStore(makeMemento());
    const c = conn({ dbType: DatabaseType.SQLITE, dbPath: '/missing.db' });

    expect((await validateConnectionPaths(store.applyOverrides(c), accessWith(['/new.db']))).valid).toBe(false);

    await store.set('c-1', { dbPath: '/new.db' });
    expect((await validateConnectionPaths(store.applyOverrides(c), accessWith(['/new.db']))).valid).toBe(true);
    expect(c.dbPath).toBe('/missing.db'); // 源值未被改写

    await store.clear('c-1');
    expect((await validateConnectionPaths(store.applyOverrides(c), accessWith(['/new.db']))).valid).toBe(false);
  });
});