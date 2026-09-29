import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { DatabaseType } from '@devbelt/db-core';

/** 记录每次真正建连时使用的 database，用于验证 PG 多库衍生会话。 */
const createdDatabases: (string | undefined)[] = [];
/** 记录每次建连时的 connectionUrl（URL 配置的 PG 衍生会话须改写库名）。 */
const createdUrls: (string | undefined)[] = [];
let endCalled = 0;
let tunnelCreated = 0;
let tunnelReleased = 0;

vi.mock('../../src/connection/sshTunnel', () => ({
  SshTunnel: {
    create: async () => { tunnelCreated++; return 12345; },
    close: () => {},
    release: () => { tunnelReleased++; },
    closeAll: () => {},
  },
}));

vi.mock('@devbelt/db-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devbelt/db-core')>();
  class FakeConnection {
    connect(cb: (err: unknown) => void): void { cb(null); }
    end(): void { endCalled++; }
    isAlive(): boolean { return true; }
    query(): void { /* noop */ }
  }
  // 注意：vi.mock 工厂会被提升到 import 之前执行，不能引用模块顶部的绑定（TDZ）。
  const dialect = {
    dbType: 'PG',
    capabilities: { operations: [], multiDatabaseExplorer: true, schemas: true },
    wrap: (s: string) => s,
  };
  class FakeQueryService {
    inFlightCount = 0;
    constructor() { /* noop */ }
    async query(): Promise<{ rows: unknown[] }> { return { rows: [] }; }
    setDialect(): void { /* noop */ }
  }
  class Stub { constructor() { /* noop */ } }
  return {
    ...actual,
    ConnectionFactory: {
      createWithDialect: (_type: unknown, config: { database?: string; connectionUrl?: string }) => {
        createdDatabases.push(config.database);
        createdUrls.push(config.connectionUrl);
        return { connection: new FakeConnection(), dialect };
      },
    },
    DialectRegistry: { getFor: () => dialect },
    QueryService: FakeQueryService,
    MetadataService: Stub,
    DataService: Stub,
    TableService: Stub,
  };
});

import { ConnectionManager, DERIVED_DB_SESSION_MAX } from '../../src/connection/connectionManager';

function conn(over: Partial<SavedConnection> = {}): SavedConnection {
  return { id: 'c-1', name: 'n', dbType: DatabaseType.PG, host: 'h', port: 5432, user: 'u', database: 'app', ...over } as SavedConnection;
}

describe('B2：PG 多库衍生会话', () => {
  const managers: ConnectionManager[] = [];
  afterEach(() => {
    managers.forEach((m) => m.disposeAll());
    createdDatabases.length = 0;
    createdUrls.length = 0;
    endCalled = 0;
    tunnelCreated = 0;
    tunnelReleased = 0;
  });

  it('指定库 → 用该库建连；同库复用；主会话用连接配置库', async () => {
    const m = new ConnectionManager();
    managers.push(m);

    const primary = await m.connectSql(conn());
    const other = await m.connectSql(conn(), 'other');
    const otherAgain = await m.connectSql(conn(), 'other');

    expect(createdDatabases).toEqual(['app', 'other']);
    expect(otherAgain).toBe(other);
    expect(primary).not.toBe(other);
    expect(m.activeConnections).toBe(2);
    // 多库会话共享同一逻辑连接：并发门禁只算 1。
    expect(m.openCount()).toBe(1);
  });

  it('B2：URL 配置的 PG 衍生会话改写 URL 库名（驱动实际连目标库）', async () => {
    const m = new ConnectionManager();
    managers.push(m);
    await m.connectSql(
      conn({ useConnectionString: true, connectionUrl: 'postgres://u:p@h:5432/app?sslmode=require' }),
      'other',
    );
    expect(createdUrls.at(-1)).toContain('/other');
    expect(createdUrls.at(-1)).toContain('sslmode=require');
    expect(createdUrls.at(-1)).not.toContain('/app');
  });

  it(`每连接最多 ${DERIVED_DB_SESSION_MAX} 个衍生库会话（LRU 淘汰）`, async () => {
    const m = new ConnectionManager();
    managers.push(m);
    await m.connectSql(conn()); // 主会话 app
    await m.connectSql(conn(), 'other');
    for (const db of ['d1', 'd2', 'd3', 'd4', 'd5']) await m.connectSql(conn(), db);

    // 主会话 + 4 个衍生。
    expect(m.activeConnections).toBe(1 + DERIVED_DB_SESSION_MAX);
    // 最旧的衍生 other 被淘汰，最新的仍在。
    expect(m.peekSql('c-1', 'other')).toBeUndefined();
    expect(m.peekSql('c-1', 'd5')).toBeTruthy();
    expect(m.openCount()).toBe(1);
  });

  it('B3：markExplicit 只保护主会话，衍生库会话仍按上限淘汰', async () => {
    const m = new ConnectionManager();
    managers.push(m);
    await m.connectSql(conn());
    m.markExplicit('c-1');
    await m.connectSql(conn(), 'other');
    for (const db of ['d1', 'd2', 'd3', 'd4', 'd5']) await m.connectSql(conn(), db);
    // 主会话不受上限影响；衍生仍被淘汰到上限。
    expect(m.peekSql('c-1')).toBeTruthy();
    expect(m.peekSql('c-1', 'other')).toBeUndefined();
    expect(m.activeConnections).toBe(1 + DERIVED_DB_SESSION_MAX);
  });

  it('disposeConn 关闭全部衍生会话并释放隧道引用', async () => {
    const m = new ConnectionManager({});
    managers.push(m);
    await m.connectSql(conn({ sshHost: 'jump' }));
    await m.connectSql(conn({ sshHost: 'jump' }), 'other');
    expect(m.activeConnections).toBe(2);

    m.disposeConn('c-1');
    expect(m.activeConnections).toBe(0);
    expect(endCalled).toBeGreaterThanOrEqual(2);
    // 两个会话各释放一次引用（不误用 force close）。
    expect(tunnelReleased).toBe(2);
  });

  it('MySQL 忽略 database：始终主会话（回归）', async () => {
    const m = new ConnectionManager();
    managers.push(m);
    const a = await m.connectSql(conn({ dbType: DatabaseType.MYSQL }));
    const b = await m.connectSql(conn({ dbType: DatabaseType.MYSQL }), 'otherdb');
    expect(b).toBe(a);
    expect(m.activeConnections).toBe(1);
  });
});