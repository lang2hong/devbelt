import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import { ConnectionManager } from '../../src/connection/connectionManager';
import type { SavedConnection } from '../../src/connection/connectionStore';

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