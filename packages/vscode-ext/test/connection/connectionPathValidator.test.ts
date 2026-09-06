import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import { validateConnectionPaths } from '../../src/connection/connectionPathValidator';
import type { SavedConnection } from '../../src/connection/connectionStore';

function conn(over: Partial<SavedConnection> = {}): SavedConnection {
  return { id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', ...over } as SavedConnection;
}

/** 注入 fake fsAccess：存在集合内的路径视为可读。 */
function accessWith(existing: string[]) {
  return async (path: string) => {
    if (!existing.includes(path)) throw new Error('ENOENT');
  };
}

describe('validateConnectionPaths', () => {
  it('无任何路径字段的连接 valid', async () => {
    const r = await validateConnectionPaths(conn(), accessWith([]));
    expect(r.valid).toBe(true);
  });

  it('org 连接跳过校验', async () => {
    const r = await validateConnectionPaths(conn({ id: 'org:1:2', dbPath: '/missing' }), accessWith([]));
    expect(r.valid).toBe(true);
  });

  it('SQLite dbPath 缺失 → 不可读', async () => {
    const c = conn({ dbType: DatabaseType.SQLITE, dbPath: '/nope/db.sqlite' });
    const r = await validateConnectionPaths(c, accessWith([]));
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual([{ field: 'dbPath', reason: 'not-readable' }]);
  });

  it('SQLite dbPath 可读 → valid', async () => {
    const c = conn({ dbType: DatabaseType.SQLITE, dbPath: '/ok/db.sqlite' });
    expect((await validateConnectionPaths(c, accessWith(['/ok/db.sqlite']))).valid).toBe(true);
  });

  it('MySQL useSSL 证书路径缺一不可（ca/cert/key 各自校验）', async () => {
    const c = conn({ useSSL: true, caPath: '/ca', clientCertPath: '/cert', clientKeyPath: '/key' });
    const r = await validateConnectionPaths(c, accessWith(['/ca']));
    expect(r.valid).toBe(false);
    expect(r.issues.map((i: { field: string }) => i.field).sort()).toEqual(['clientCertPath', 'clientKeyPath']);
  });

  it('SSH 私钥路径校验', async () => {
    const c = conn({ sshHost: 'ssh', sshPrivateKeyPath: '/keyfile' });
    expect((await validateConnectionPaths(c, accessWith([]))).valid).toBe(false);
    expect((await validateConnectionPaths(c, accessWith(['/keyfile']))).valid).toBe(true);
  });

  it('socketPath 校验', async () => {
    const c = conn({ socketPath: '/var/run/mysql.sock' });
    expect((await validateConnectionPaths(c, accessWith(['/var/run/mysql.sock']))).valid).toBe(true);
  });

  it('SQLite sqliteCommand 显式配置须可读（未配置自动探测不强制）', async () => {
    const c = conn({ dbType: DatabaseType.SQLITE, sqliteCommand: '/usr/bin/sqlite3' });
    expect((await validateConnectionPaths(c, accessWith([]))).valid).toBe(false);
    expect((await validateConnectionPaths(c, accessWith(['/usr/bin/sqlite3']))).valid).toBe(true);
    // 未配置 sqliteCommand：自动探测，不强制
    expect((await validateConnectionPaths(conn({ dbType: DatabaseType.SQLITE }), accessWith([]))).valid).toBe(true);
  });

  it('useConnectionString 时 connectionUrl 必须非空（不做 fs 校验）', async () => {
    const c = conn({ useConnectionString: true, connectionUrl: '' });
    const r = await validateConnectionPaths(c, accessWith([]));
    expect(r.valid).toBe(false);
    expect(r.issues).toEqual([{ field: 'connectionUrl', reason: 'missing' }]);

    expect((await validateConnectionPaths(conn({ useConnectionString: true, connectionUrl: 'mysql://u@h/db' }), accessWith([]))).valid).toBe(true);
  });
});
