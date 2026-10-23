import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { buildAgentTools, toModelTools } from '../../src/agent/tools.js';
import type { AgentToolHost } from '../../src/agent/tools.js';

function host(over: Partial<AgentToolHost> = {}) {
  const sql: string[] = [];
  const tables = [{ name: 'orders', comment: 'orders table' }, { name: 'users', comment: '' }];
  const columns = [
    { name: 'id', simpleType: 'int', type: 'int', comment: '', key: 'PRI', isNotNull: true },
    { name: 'status', simpleType: 'varchar', type: 'varchar', comment: 'state', key: '', isNotNull: false },
    { name: 'password', simpleType: 'varchar', type: 'varchar', comment: '', key: '', isNotNull: false },
  ];
  const base: AgentToolHost = {
    dbType: DatabaseType.PG,
    database: 'app',
    schema: 'public',
    readOnlySession: false,
    includeSample: false,
    maxRows: 100,
    session: {
      async query(statement: string) {
        sql.push(statement);
        if (statement.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': 'Seq Scan on orders' }] } as never;
        if (statement.startsWith('SELECT * FROM (')) return { rows: [{ id: 1, status: 'paid', password: 'p' }], fields: [{ name: 'id' }, { name: 'status' }, { name: 'password' }] } as never;
        return { rows: [] } as never;
      },
      metadata: {
        async getTables() { return tables as never; },
        async getColumns() { return columns as never; },
        async getIndexes() { return [{ name: 'orders_pkey', columns: ['id'], isUnique: true, isPrimary: true }] as never; },
        async getForeignKeys() { return [{ tableName: 'orders', columnName: 'user_id', refTable: 'users', refColumn: 'id', constraintName: 'fk_user' }] as never; },
      },
    },
  };
  return { host: { ...base, ...over } as AgentToolHost, sql };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) },
});
const signal = new AbortController().signal;
const run = (tools: ReturnType<typeof buildAgentTools>, name: string, args: Record<string, unknown> = {}) =>
  tools.execute(call(name, args), args, signal);

describe('agent tools', () => {
  it('exposes five read-only tools with flat schemas', () => {
    const { host: h } = host();
    const tools = buildAgentTools(h);
    expect(tools.definitions.map((d) => d.name)).toEqual([
      'list_schemas', 'list_tables', 'describe_table', 'explain_query', 'run_read_only_query',
    ]);
    for (const def of tools.definitions) {
      expect(def.riskClass === 'R0' || def.riskClass === 'R1').toBe(true);
      expect(def.mcp).toBe(false);
      expect((def.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
    const modelTools = toModelTools(tools.definitions);
    expect(modelTools[0]).toEqual({ type: 'function', function: { name: 'list_schemas', description: expect.any(String), parameters: expect.any(Object) } });
  });

  it('lists tables through metadata and sanitises the result', async () => {
    const { host: h } = host();
    const tools = buildAgentTools(h);
    const out = await run(tools, 'list_tables');
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('orders');
    expect(out.summary).toBe('表 2 个');
  });

  it('describes a table including indexes and foreign keys', async () => {
    const { host: h } = host();
    const tools = buildAgentTools(h);
    const out = await run(tools, 'describe_table', { table: 'orders' });
    const parsed = JSON.parse(out.content);
    expect(parsed.data[0].columns).toHaveLength(3);
    expect(parsed.data[0].columns.find((c: { name: string }) => c.name === 'password').sensitive).toBe(true);
    expect(parsed.data[0].indexes[0].name).toBe('orders_pkey');
    expect(parsed.data[0].foreignKeys[0].refTable).toBe('users');
  });

  it('reports a missing table as an error', async () => {
    const { host: h } = host();
    h.session.metadata.getColumns = async () => [];
    const out = await run(buildAgentTools(h), 'describe_table', { table: 'nope' });
    expect(out).toMatchObject({ isError: true, summary: '表不存在' });
  });

  it('rejects writes before touching the database', async () => {
    const { host: h, sql } = host();
    const tools = buildAgentTools(h);
    for (const name of ['run_read_only_query', 'explain_query']) {
      const out = await run(tools, name, { sql: 'DELETE FROM orders' });
      expect(out.isError).toBe(true);
      expect(out.summary).toContain('被拒');
    }
    expect(sql).toEqual([]);
  });

  it('runs EXPLAIN inside the read-only scope and summarises the plan', async () => {
    const { host: h, sql } = host();
    const out = await run(buildAgentTools(h), 'explain_query', { sql: 'SELECT * FROM orders' });
    expect(out.content).toContain('Seq Scan');
    expect(out.summary).toBe('计划 1 行');
    expect(sql).toEqual(['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 30000', 'EXPLAIN SELECT * FROM orders', 'ROLLBACK']);
  });

  it('runs a read-only query with a row limit and no sample by default', async () => {
    const { host: h, sql } = host();
    const out = await run(buildAgentTools(h), 'run_read_only_query', { sql: 'SELECT id, status, password FROM orders' });
    expect(out.summary).toBe('读取 1 行');
    expect(out.content).not.toContain('"p"');
    expect(out.content).toContain('password');
    expect(sql).toContain('SELECT * FROM (SELECT id, status, password FROM orders) AS devbelt_q LIMIT 101');
    expect(sql.at(-1)).toBe('ROLLBACK');
  });

  it('uses SQLite EXPLAIN QUERY PLAN and requires a read-only session', async () => {
    const { host: h, sql } = host({ dbType: DatabaseType.SQLITE, readOnlySession: true });
    const tools = buildAgentTools(h);
    await run(tools, 'explain_query', { sql: 'SELECT 1' });
    expect(sql).toContain('EXPLAIN QUERY PLAN SELECT 1');

    const { host: rw } = host({ dbType: DatabaseType.SQLITE, readOnlySession: false });
    const out = await run(buildAgentTools(rw), 'run_read_only_query', { sql: 'SELECT 1' });
    expect(out).toMatchObject({ isError: true });
    expect(out.summary).toContain('session_not_read_only');
  });
});