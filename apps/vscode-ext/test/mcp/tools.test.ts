import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { buildMcpTools } from '../../src/mcp/tools';
import { McpAuditLog } from '../../src/mcp/audit';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const conn = (over: Partial<SavedConnection> = {}): SavedConnection => ({
  id: 'c1', name: 'db', dbType: DatabaseType.MYSQL, host: 'h', port: 3306, user: 'u', database: 'app', environment: 'dev', ...over,
} as SavedConnection);

function session(sql: string[] = []) {
  return {
    query: { async query(statement: string) { sql.push(statement); return { rows: [] } as never; }, wrap: (v: string) => `"${v}"` },
    metadata: {
      async getTables() { return [{ name: 'orders', comment: '' }] as never; },
      async getColumns() { return [] as never; },
      async getIndexes() { return [] as never; },
      async getForeignKeys() { return [] as never; },
    },
  };
}

async function auditLog(): Promise<{ audit: McpAuditLog; read: () => Promise<unknown[]> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'mcp-tools-'));
  const audit = new McpAuditLog(join(dir, 'audit.jsonl'));
  return { audit, read: async () => audit.read() };
}

function deps(over: Partial<Parameters<typeof buildMcpTools>[0]> = {}, sql: string[] = []) {
  return {
    conn: conn(),
    database: 'app',
    clientId: 'cl1',
    includeSample: false,
    maxRows: 100,
    ...over,
    audit: over.audit ?? new McpAuditLog('/tmp/never-used.jsonl'),
    openSession: over.openSession ?? (async () => ({ session: session(sql) as never, close: () => undefined })),
  } as Parameters<typeof buildMcpTools>[0];
}

describe('MCP tools', () => {
  it('exposes five read-only tools and no write tools', () => {
    const names = buildMcpTools(deps()).map((t) => t.name);
    expect(names).toEqual(['list_schemas', 'list_tables', 'describe_table', 'explain_query', 'run_read_only_query']);
  });

  it('runs list_tables and audits the call', async () => {
    const { audit, read } = await auditLog();
    const tools = buildMcpTools(deps({ audit }));
    const out = await tools.find((t) => t.name === 'list_tables')!.handler({});
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain('orders');
    expect(await read()).toEqual([expect.objectContaining({ tool: 'list_tables', result: 'ok', clientId: 'cl1' })]);
  });

  it('rejects writes through the read-only tool', async () => {
    const { audit, read } = await auditLog();
    const tools = buildMcpTools(deps({ audit }));
    const out = await tools.find((t) => t.name === 'run_read_only_query')!.handler({ sql: 'DELETE FROM orders' });
    expect(out.isError).toBe(true);
    expect((await read())[0]).toMatchObject({ tool: 'run_read_only_query', result: 'error' });
  });

  it('denies production connections before opening a session', async () => {
    const { audit, read } = await auditLog();
    let opened = 0;
    const tools = buildMcpTools(deps({
      conn: conn({ environment: 'production' }),
      audit,
      openSession: async () => { opened += 1; return { session: session() as never, close: () => undefined }; },
    }));
    const out = await tools.find((t) => t.name === 'list_tables')!.handler({});
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('mcp_production_denied');
    expect(opened).toBe(0);
    expect((await read())[0]).toMatchObject({ result: 'rejected', errorCode: 'mcp_production_denied' });
  });

  it('sets the PG search_path on the session when a schema is configured', async () => {
    const sql: string[] = [];
    const tools = buildMcpTools(deps({
      conn: conn({ dbType: DatabaseType.PG }),
      schema: 'sales',
      openSession: async () => ({ session: session(sql) as never, close: () => undefined }),
    }));
    await tools.find((t) => t.name === 'list_tables')!.handler({});
    expect(sql[0]).toContain('SET search_path TO');
    expect(sql[0]).toContain('sales');
  });
});