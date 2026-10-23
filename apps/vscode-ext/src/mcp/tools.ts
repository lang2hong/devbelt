import { z } from 'zod';
import type { SqlConnectionSession } from '../connection/connectionSession.js';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { DatabaseType } from '@devbelt/db-core';
import {
  defineToolRegistry,
  guardToolCall,
  type AgentSettings,
  type ToolDefinition,
} from '@devbelt/agent-core';
import { buildAgentTools, agentEngineOf, bindAgentSession } from '../agent/tools.js';
import type { McpAuditLog } from './audit.js';

export interface McpToolDeps {
  conn: SavedConnection;
  database?: string;
  schema?: string;
  clientId: string;
  includeSample: boolean;
  maxRows: number;
  audit: McpAuditLog;
  openSession(): Promise<{ session: SqlConnectionSession; close: () => void }>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler(args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

/** MCP exposes read-only tools only; the target connection is fixed per server. */
export function buildMcpTools(deps: McpToolDeps): McpTool[] {
  const engine = agentEngineOf(deps.conn.dbType);
  const settings: AgentSettings = {
    agentEnabled: false,
    allowWrites: false,
    allowDdl: false,
    allowProduction: false,
    mcpEnabled: true,
    mcpAllowedConnections: [deps.conn.id],
  };
  const base = buildAgentTools({
    dbType: deps.conn.dbType,
    ...(deps.database ? { database: deps.database } : {}),
    ...(deps.schema ? { schema: deps.schema } : {}),
    session: undefined as never,
    readOnlySession: deps.conn.readOnly === true,
    includeSample: deps.includeSample,
    maxRows: deps.maxRows,
  });
  const definitions: ToolDefinition[] = base.definitions.map((d) => ({ ...d, mcp: true }));
  const registry = defineToolRegistry(definitions);

  const run = (name: string, args: Record<string, unknown>) => async () => {
    const started = Date.now();
    const guarded = guardToolCall(registry, {
      surface: 'mcp',
      toolName: name,
      args,
      connectionId: deps.conn.id,
      connection: {
        dialect: engine,
        production: deps.conn.environment === 'production',
        readOnly: deps.conn.readOnly === true,
      },
      settings,
    });
    if (!guarded.allowed) {
      await deps.audit.append({
        at: Date.now(), clientId: deps.clientId, tool: name, connectionId: deps.conn.id,
        result: 'rejected', durationMs: 0, errorCode: guarded.reason,
      });
      return { content: [{ type: 'text' as const, text: `Rejected: ${guarded.reason}` }], isError: true };
    }
    const opened = await deps.openSession();
    try {
      if (deps.conn.dbType === DatabaseType.PG && deps.schema) {
        await opened.session.query.query(
          `SET search_path TO ${opened.session.query.wrap(deps.schema)}, public`,
          undefined,
          { skipHistory: true },
        );
      }
      const tools = buildAgentTools({
        dbType: deps.conn.dbType,
        ...(deps.database ? { database: deps.database } : {}),
        ...(deps.schema ? { schema: deps.schema } : {}),
        session: bindAgentSession(opened.session),
        readOnlySession: deps.conn.readOnly === true,
        includeSample: deps.includeSample,
        maxRows: deps.maxRows,
      });
      const call = { id: `mcp-${Date.now()}`, type: 'function' as const, function: { name, arguments: JSON.stringify(guarded.args) } };
      const controller = new AbortController();
      const out = await tools.execute(call, guarded.args, controller.signal);
      await deps.audit.append({
        at: Date.now(), clientId: deps.clientId, tool: name, connectionId: deps.conn.id,
        result: out.isError ? 'error' : 'ok', durationMs: Date.now() - started,
        ...(out.errorCode ? { errorCode: out.errorCode } : {}),
      });
      return { content: [{ type: 'text' as const, text: out.content }], ...(out.isError ? { isError: true } : {}) };
    } catch (err) {
      await deps.audit.append({
        at: Date.now(), clientId: deps.clientId, tool: name, connectionId: deps.conn.id,
        result: 'error', durationMs: Date.now() - started, errorCode: 'tool_failed',
      });
      return { content: [{ type: 'text' as const, text: `Tool failed: ${messageOf(err)}` }], isError: true };
    } finally {
      opened.close();
    }
  };

  return [
    { name: 'list_schemas', description: 'List databases / schemas on the configured connection.', inputSchema: {}, handler: run('list_schemas', {}) },
    { name: 'list_tables', description: 'List tables and views in the configured database / schema.', inputSchema: {}, handler: run('list_tables', {}) },
    {
      name: 'describe_table',
      description: 'Describe one table: columns, indexes and foreign keys.',
      inputSchema: { table: z.string().max(128) },
      handler: (args) => run('describe_table', args)(),
    },
    {
      name: 'explain_query',
      description: 'Run a plain EXPLAIN (never ANALYZE) for a read-only SELECT.',
      inputSchema: { sql: z.string().max(10_000) },
      handler: (args) => run('explain_query', args)(),
    },
    {
      name: 'run_read_only_query',
      description: 'Run one read-only SELECT and return a bounded summary.',
      inputSchema: {
        sql: z.string().max(10_000),
        maxRows: z.number().int().min(1).max(1000).optional(),
        includeSample: z.boolean().optional(),
      },
      handler: (args) => run('run_read_only_query', args)(),
    },
  ];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}