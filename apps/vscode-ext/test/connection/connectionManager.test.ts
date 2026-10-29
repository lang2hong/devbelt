import { afterEach, describe, expect, it, vi } from 'vitest';

// connectionManager → sshTunnel → utils/diagnostics 会 import vscode。
vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }) },
}));

import { DatabaseType } from '@devbelt/db-core';
import { ConcurrentConnectionLimitError, ConnectionManager } from '../../src/connection/connectionManager';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';

function conn(over: Partial<SavedConnection> = {}): SavedConnection {
  return { id: 'c-1', name: 'n', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', ...over } as SavedConnection;
}

describe('ConnectionManager effective config', () => {
  const managers: ConnectionManager[] = [];
  afterEach(() => { managers.forEach((m) => m.disposeAll()); });

  it('validateConnectionPath 应用 resolveEffective（覆盖优先）', async () => {
    // effective 清掉 SQLite dbPath → 无路径字段校验 → valid，证明走的是有效配置而非原始 conn。
    const manager = new ConnectionManager(undefined, undefined, (c) => ({ ...c, dbPath: undefined }));
    managers.push(manager);
    const r = await manager.validateConnectionPath(conn({ dbType: DatabaseType.SQLITE, dbPath: '/does/not/exist/db.sqlite' }));
    expect(r.valid).toBe(true);
  });

  it('无 resolveEffective 时按原始配置校验（路径缺失 → 拒绝）', async () => {
    const manager = new ConnectionManager(undefined, undefined);
    managers.push(manager);
    const r = await manager.validateConnectionPath(conn({ dbType: DatabaseType.SQLITE, dbPath: '/does/not/exist/db.sqlite' }));
    expect(r.valid).toBe(false);
  });
});
describe('ConnectionManager 并发连接上限', () => {
  function fakeSession(alive = true): any {
    return { kind: 'sql', isAlive: () => alive, close: () => {} };
  }

  it('达到上限时拒绝新连接，并带上限值', async () => {
    const manager = new ConnectionManager(undefined, undefined, undefined, () => 2);
    const entries = (manager as any).sessionEntries as Map<string, unknown>;
    entries.set('a', { session: fakeSession(), connId: 'a', key: 'a', lastUsed: 0 });
    entries.set('b', { session: fakeSession(), connId: 'b', key: 'b', lastUsed: 0 });

    await expect(manager.connect(conn({ id: 'c' }))).rejects.toBeInstanceOf(ConcurrentConnectionLimitError);
    await expect(manager.connect(conn({ id: 'c' }))).rejects.toMatchObject({ limit: 2 });
    manager.disposeAll();
  });

  it('同一连接的多库会话不重复占名额', async () => {
    const manager = new ConnectionManager(undefined, undefined, undefined, () => 2);
    const entries = (manager as any).sessionEntries as Map<string, unknown>;
    entries.set('c\u0000db1', { session: fakeSession(), connId: 'c', key: 'c\u0000db1', lastUsed: 0 });
    entries.set('c\u0000db2', { session: fakeSession(), connId: 'c', key: 'c\u0000db2', lastUsed: 0 });
    (manager as any).doConnect = async (c: any, _db: unknown, key: string) => {
      const session = fakeSession();
      (manager as any).registerSession(key, session, { session, connId: c.id, key, lastUsed: 0 });
      return session;
    };
    // 已打开两个衍生库会话的连接再开主会话：仍在 Free 的 2 个连接以内。
    await expect(manager.connect(conn({ id: 'c' }))).resolves.toBeTruthy();
    manager.disposeAll();
  });

  it('死会话不占名额；0 = 不限', async () => {
    const manager = new ConnectionManager(undefined, undefined, undefined, () => 0);
    const entries = (manager as any).sessionEntries as Map<string, unknown>;
    entries.set('a', { session: fakeSession(false), connId: 'a', key: 'a', lastUsed: 0 });
    (manager as any).doConnect = async (c: any, _db: unknown, key: string) => {
      const session = fakeSession();
      (manager as any).registerSession(key, session, { session, connId: c.id, key, lastUsed: 0 });
      return session;
    };
    await expect(manager.connect(conn({ id: 'd' }))).resolves.toBeTruthy();
    manager.disposeAll();
  });
});
