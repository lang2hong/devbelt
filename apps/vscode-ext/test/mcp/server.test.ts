import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { McpServerHost } from '../../src/mcp/server';
import { McpTokenStore } from '../../src/mcp/tokenStore';
import { McpAuditLog } from '../../src/mcp/audit';

const conn = {
  id: 'c1', name: 'db', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', database: 'app', environment: 'dev',
} as unknown as SavedConnection;

function tokens() {
  const memento = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return new McpTokenStore(
    { get: <T>(k: string, d: T) => (memento.get(k) as T) ?? d, update: async (k, v) => { memento.set(k, v); } },
    { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
  );
}

const hosts: McpServerHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function start(over: { conn?: SavedConnection | undefined } = {}) {
  const store = tokens();
  const host = new McpServerHost({
    tokens: store,
    audit: new McpAuditLog('/tmp/never-used-mcp.jsonl'),
    manager: { openIsolatedSql: async () => { throw new Error('should not open a session'); } } as never,
    getConnection: () => ('conn' in over ? over.conn : conn),
    getSettings: () => ({ rateLimitPerMinute: 60, includeSample: false, maxRows: 10 }),
  });
  hosts.push(host);
  const endpoint = await host.start();
  return { host, endpoint, tokens: store };
}

describe('McpServerHost', () => {
  it('refuses to start without a connection', async () => {
    const host = new McpServerHost({
      tokens: tokens(),
      audit: new McpAuditLog('/tmp/never-used-mcp.jsonl'),
      manager: {} as never,
      getConnection: () => undefined,
      getSettings: () => ({ rateLimitPerMinute: 60, includeSample: false, maxRows: 10 }),
    });
    await expect(host.start()).rejects.toThrow(/configured connection/);
  });

  it('rejects non-POST, bad paths, foreign origins and missing tokens', async () => {
    const { endpoint, tokens: store } = await start();
    expect((await fetch(endpoint)).status).toBe(404);
    expect((await fetch(endpoint.replace('/mcp', '/other'), { method: 'POST' })).status).toBe(404);
    expect((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const { token } = await store.create('t');
    expect((await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect(token).toBeTruthy();
  });

  it('is loopback-only and reports an endpoint', async () => {
    const { endpoint } = await start();
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
});