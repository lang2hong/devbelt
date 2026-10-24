import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConnectionFactory, DatabaseType, MetadataService, QueryService } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { McpServerHost } from '../../src/mcp/server';
import { McpTokenStore } from '../../src/mcp/tokenStore';
import { McpAuditLog } from '../../src/mcp/audit';

const HAS_SQLITE = (() => {
  try { return spawnSync('sqlite3', ['-version']).status === 0; } catch { return false; }
})();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tokens() {
  const memento = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return new McpTokenStore(
    { get: <T>(k: string, d: T) => (memento.get(k) as T) ?? d, update: async (k, v) => { memento.set(k, v); } },
    { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
  );
}

describe.skipIf(!HAS_SQLITE)('MCP client against the real server (SQLite)', () => {
  it('lists the five read-only tools and runs list_tables over Streamable HTTP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 't.db');
    expect(spawnSync('sqlite3', [file, 'CREATE TABLE orders (id INTEGER PRIMARY KEY); INSERT INTO orders VALUES (1);']).status).toBe(0);

    const { connection, dialect } = ConnectionFactory.createWithDialect(DatabaseType.SQLITE, {
      host: '', port: 0, user: '', dbPath: file, readOnly: true, sqliteCommand: 'sqlite3',
    } as never);
    await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
    const q = new QueryService(connection, dialect);
    const metadata = new MetadataService(q);
    cleanups.push(() => q.end());

    const store = tokens();
    const host = new McpServerHost({
      tokens: store,
      audit: new McpAuditLog(path.join(dir, 'audit.jsonl')),
      manager: {
        openIsolatedSql: async () => ({ session: { query: q, metadata } as never, close: () => undefined }),
      } as never,
      getConnection: () => ({ id: 'c1', name: 'db', dbType: DatabaseType.SQLITE, host: '', port: 0, user: '', database: 'main', environment: 'dev' } as unknown as SavedConnection),
      getSettings: () => ({ rateLimitPerMinute: 60, includeSample: false, maxRows: 50 }),
    });
    const endpoint = await host.start();
    cleanups.push(() => host.stop());
    const { token } = await store.create('integration');

    const client = new Client({ name: 'devbelt-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'describe_table', 'explain_query', 'list_schemas', 'list_tables', 'run_read_only_query',
    ]);

    const result = await client.callTool({ name: 'list_tables', arguments: {} });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toContain('orders');
  }, 60_000);
});