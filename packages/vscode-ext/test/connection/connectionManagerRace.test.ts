import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '../../src/connection/connectionStore';

/** 由 mock 的 FakeConnection.connect 注入，模拟"建连尚未完成"。 */
let resolveConnect: (() => void) | undefined;
let endCalled = 0;
let tunnelClosed = 0;

vi.mock('../../src/connection/sshTunnel', () => ({
  SshTunnel: {
    create: async () => 12345,
    close: () => { tunnelClosed++; },
    closeAll: () => {},
  },
}));

vi.mock('@db-client/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@db-client/core')>();
  class FakeConnection {
    connect(cb: (err: unknown) => void): void { resolveConnect = () => cb(null); }
    end(): void { endCalled++; }
    isAlive(): boolean { return true; }
    query(): void { /* noop */ }
  }
  const dialect = { capabilities: { operations: [] }, wrap: (s: string) => s, dbType: 'MYSQL' };
  return {
    ...actual,
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
    endCalled = 0;
    tunnelClosed = 0;
  });

  it('dispose during in-flight connect self-destroys (no ghost session)', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const pending = manager.connect(conn());
    await waitForConnect();
    manager.disposeConn('c-1');
    resolveConnect!();

    await expect(pending).rejects.toThrow(/closed/i);
    expect(manager.peek('c-1')).toBeUndefined();
    expect(manager.activeConnections).toBe(0);
    expect(endCalled).toBeGreaterThan(0);
  });

  it('dispose during in-flight connect also closes the SSH tunnel', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const pending = manager.connect(conn({ sshHost: 'jump.example.com', sshUser: 'jump' }));
    await waitForConnect();
    manager.disposeConn('c-1');
    resolveConnect!();

    await expect(pending).rejects.toThrow(/closed/i);
    expect(tunnelClosed).toBeGreaterThan(0);
    expect(manager.activeConnections).toBe(0);
  });

  it('can reconnect cleanly after a disposed in-flight attempt', async () => {
    const manager = new ConnectionManager();
    managers.push(manager);

    const first = manager.connect(conn());
    await waitForConnect();
    manager.disposeConn('c-1');
    resolveConnect!();
    await expect(first).rejects.toThrow(/closed/i);

    resolveConnect = undefined;
    const second = manager.connect(conn());
    await waitForConnect();
    resolveConnect!();
    const session = await second;

    expect(session).toBeTruthy();
    expect(manager.activeConnections).toBe(1);
  });
});