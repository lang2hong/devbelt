import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { DatabaseType } from '@devbelt/db-core';

/** 由 mock 的 FakeConnection.connect 注入，模拟"建连尚未完成"。 */
let resolveConnect: (() => void) | undefined;
/** 每次建连的独立 resolver，便于在并发场景中分别放行。 */
const resolvers: Array<() => void> = [];
let endCalled = 0;
let tunnelClosed = 0;

vi.mock('../../src/connection/sshTunnel', () => ({
  SshTunnel: {
    create: async () => ({ port: 12345, lease: 'race-lease' }),
    close: () => { tunnelClosed++; },
    release: () => { tunnelClosed++; },
    closeAll: () => {},
  },
}));

vi.mock('@devbelt/db-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devbelt/db-core')>();
  class FakeConnection {
    connect(cb: (err: unknown) => void): void {
      const resolve = () => cb(null);
      resolvers.push(resolve);
      resolveConnect = resolve;
    }
    end(): void { endCalled++; }
    isAlive(): boolean { return true; }
    query(): void { /* noop */ }
  }
  class FakeRedisClient {
    private alive = true;
    constructor(_opts: unknown) { /* noop */ }
    async connect(): Promise<void> { /* noop */ }
    async ping(): Promise<string> { return 'PONG'; }
    async close(): Promise<void> { this.alive = false; }
    isAlive(): boolean { return this.alive; }
    async sendCommand(): Promise<unknown> { return 'OK'; }
    async info(): Promise<string> { return ''; }
  }
  const dialect = { capabilities: { operations: [] }, wrap: (s: string) => s, dbType: 'MYSQL' };
  return {
    ...actual,
    RedisClient: FakeRedisClient,
    buildRedisTlsOptions: (input: unknown) => input,
    ConnectionFactory: { createWithDialect: () => ({ connection: new FakeConnection(), dialect }) },
    QueryService: class { constructor() { /* noop */ } },
    MetadataService: class { constructor() { /* noop */ } },
    DataService: class { constructor() { /* noop */ } },
    TableService: class { constructor() { /* noop */ } },
  };
});

import { ConnectionManager } from '../../src/connection/connectionManager';

function conn(over: Partial<SavedConnection> = {}): SavedConnection {
  return { id: 'c-1', name: 'n', dbType: 'MYSQL', host: 'h', port: 3306, user: 'u', ...over } as SavedConnection;
}

async function waitForConnect(): Promise<void> {
  await vi.waitFor(() => {
    if (!resolveConnect) throw new Error('connection.connect not reached yet');
  });
}

describe('ConnectionManager dispose/connect race', () => {
  const managers: ConnectionManager[] = [];
  afterEach(() => {
    managers.forEach((m) => m.disposeAll());
    resolveConnect = undefined;
    resolvers.length = 0;
    endCalled = 0;
    tunnelClosed = 0;
  });

  it('dispose during in-flight connect self-destroys (no ghost session)', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const pending = manager.connectSql(conn());
    await waitForConnect();
    manager.disposeConn('c-1');
    resolveConnect!();

    await expect(pending).rejects.toThrow(/closed/i);
    expect(manager.peekSql('c-1')).toBeUndefined();
    expect(manager.activeConnections).toBe(0);
    expect(endCalled).toBeGreaterThan(0);
  });

  it('dispose during in-flight connect also closes the SSH tunnel', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const pending = manager.connectSql(conn({ sshHost: 'jump.example.com', sshUser: 'jump' }));
    await waitForConnect();
    manager.disposeConn('c-1');
    resolveConnect!();

    await expect(pending).rejects.toThrow(/closed/i);
    expect(tunnelClosed).toBeGreaterThan(0);
    expect(manager.activeConnections).toBe(0);
  });

  it('closeAllForAccountSwitch：清算在途建连并返回连接 id', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const pending = manager.connectSql(conn());
    await waitForConnect();
    const closed = manager.closeAllForAccountSwitch();
    expect(closed).toContain('c-1');

    resolveConnect!();
    await expect(pending).rejects.toThrow(/closed/i);
    expect(manager.activeConnections).toBe(0);
  });

  it('retain/release 引用计数：归零且非显式才关闭', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);
    const pending = manager.connectSql(conn());
    await waitForConnect();
    resolveConnect!();
    await pending;

    manager.retain('c-1');
    manager.retain('c-1');
    manager.release('c-1');
    // 仍有另一个持有者 → 不关闭。
    expect(manager.activeConnections).toBe(1);
    manager.release('c-1');
    expect(manager.activeConnections).toBe(0);
    expect(endCalled).toBeGreaterThan(0);
  });

  it('显式打开的连接 release 归零也不关闭', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);
    const pending = manager.connectSql(conn());
    await waitForConnect();
    resolveConnect!();
    await pending;

    manager.markExplicit('c-1');
    manager.retain('c-1');
    manager.release('c-1');
    expect(manager.activeConnections).toBe(1);
  });

  it('openCount 计入在建连会话（并发门禁不被绕过）', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    expect(manager.openCount()).toBe(0);
    const pending = manager.connectSql(conn());
    await waitForConnect();
    // 尚未 resolve，sessions 里还没有它；门禁若不数在建连就会放行超出套餐的连接。
    expect(manager.openCount()).toBe(1);
    resolveConnect!();
    await pending;
    expect(manager.openCount()).toBe(1);
  });

  it('旧连接的 finally 不会误删重连后的 connecting 标记（去重不被绕过）', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const a = manager.connectSql(conn());
    await waitForConnect();
    manager.disposeConn('c-1'); // 清掉 connecting 以允许重连
    const b = manager.connectSql(conn());
    await vi.waitFor(() => {
      if (resolvers.length < 2) throw new Error('reconnect not started');
    });

    // 放行 A：代际不匹配应自毁，且其 finally 不得删除 B 的标记。
    resolvers[0]();
    await expect(a).rejects.toThrow(/closed/i);
    // 标记仍在 → 再次 connect 复用 B，不会发起第三次真实建连。
    const c = manager.connectSql(conn());
    expect(resolvers.length).toBe(2);

    resolvers[1]();
    const session = await b;
    expect(await c).toBe(session);
    expect(manager.activeConnections).toBe(1);
  });

  it('被 retain 的连接不被 LRU 淘汰', async () => {
    const manager = new ConnectionManager({ maxConnections: 1 });
    managers.push(manager);

    const p1 = manager.connectSql(conn({ id: 'c-1' }));
    await waitForConnect();
    resolvers[0]();
    await p1;
    manager.retain('c-1');

    // 连第二个连接触发淘汰：被持有的 c-1 必须豁免。
    const p2 = manager.connectSql(conn({ id: 'c-2' }));
    await vi.waitFor(() => {
      if (resolvers.length < 2) throw new Error('second connect not started');
    });
    resolvers[1]();
    await p2;

    expect(manager.peekSql('c-1')).toBeTruthy();
    expect(manager.peekSql('c-2')).toBeTruthy();
  });

  it('can reconnect cleanly after a disposed in-flight attempt', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const first = manager.connectSql(conn());
    await waitForConnect();
    manager.disposeConn('c-1');
    resolveConnect!();
    await expect(first).rejects.toThrow(/closed/i);

    resolveConnect = undefined;
    const second = manager.connectSql(conn());
    await waitForConnect();
    resolveConnect!();
    const session = await second;

    expect(session).toBeTruthy();
    expect(manager.activeConnections).toBe(1);
  });

  it('REDIS 连接：装配 kind:redis 会话；connectSql 对其抛 NotSqlSessionError', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const session = await manager.connect(conn({ dbType: DatabaseType.REDIS, port: 6379 }));
    expect(session.kind).toBe('redis');
    expect(manager.peek('c-1')?.kind).toBe('redis');
    // SQL 访问器不得返回 Redis 会话；Redis 连接也不应误建隧道。
    expect(manager.peekSql('c-1')).toBeUndefined();
    expect(manager.openCount()).toBe(1);
    expect(tunnelClosed).toBe(0);

    await expect(manager.connectSql(conn({ dbType: DatabaseType.REDIS, port: 6379 })))
      .rejects.toThrow(/expected a SQL connection session/);
  });
});