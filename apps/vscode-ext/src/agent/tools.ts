import { DatabaseType } from '@devbelt/db-core';
import type { ColumnMeta, ForeignKeyMeta, IndexMeta, TableMeta } from '@devbelt/db-core';
import type { SqlConnectionSession } from '../connection/connectionSession.js';
import type { ToolCall } from '@devbelt/ai-core';
import type { AgentEngine, ToolDefinition } from '@devbelt/agent-core';
import {
  explainReadOnly,
  runReadOnlyQuery,
  sanitizeMetadata,
  sanitizePlanSummary,
  sanitizeToolError,
} from '@devbelt/agent-core';
import type { ReadOnlyQuerySession } from '@devbelt/agent-core';
import type { ToolOutcome } from './runner.js';

export interface AgentMetadataSession {
  getTables(database?: string, schema?: string): Promise<TableMeta[]>;
  getColumns(table: string, database?: string, schema?: string): Promise<ColumnMeta[]>;
  getIndexes(table: string, database?: string, schema?: string): Promise<IndexMeta[]>;
  getForeignKeys(database?: string, schema?: string): Promise<ForeignKeyMeta[]>;
}

export interface AgentToolHost {
  dbType: DatabaseType;
  database?: string;
  schema?: string;
  /** Isolated SQL session; same connection the metadata reads come from. */
  session: ReadOnlyQuerySession & { metadata: AgentMetadataSession };
  /** Read-only target for the runtime (engine + session + SQLite read-only flag). */
  readOnlySession: boolean;
  includeSample: boolean;
  maxRows: number;
}

export interface AgentTools {
  definitions: ToolDefinition[];
  execute(call: ToolCall, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

const RESULT_CHARS = 8000;

export function agentEngineOf(dbType: DatabaseType): AgentEngine {
  switch (dbType) {
    case DatabaseType.MYSQL: return 'MYSQL';
    case DatabaseType.PG: return 'PG';
    case DatabaseType.SQLITE: return 'SQLITE';
    default: throw new Error(`agent tools do not support ${dbType}`);
  }
}

const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

/** Tools available to the read-only agent. Target connection is never an argument. */
export const AGENT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'list_schemas',
    description: 'List the databases / schemas visible on the current connection.',
    riskClass: 'R0',
    engines: ['MYSQL', 'PG', 'SQLITE'],
    mcp: false,
    parameters: objectSchema(),
  },
  {
    name: 'list_tables',
    description: 'List tables and views in the current database / schema.',
    riskClass: 'R0',
    engines: ['MYSQL', 'PG', 'SQLITE'],
    mcp: false,
    parameters: objectSchema(),
  },
  {
    name: 'describe_table',
    description: 'Describe one table: columns, indexes and foreign keys.',
    riskClass: 'R0',
    engines: ['MYSQL', 'PG', 'SQLITE'],
    mcp: false,
    parameters: objectSchema({ table: { type: 'string', maxLength: 128 } }, ['table']),
  },
  {
    name: 'explain_query',
    description: 'Run a plain EXPLAIN (never ANALYZE) for a read-only SELECT.',
    riskClass: 'R0',
    engines: ['MYSQL', 'PG', 'SQLITE'],
    mcp: false,
    parameters: objectSchema({ sql: { type: 'string', maxLength: 10_000 } }, ['sql']),
  },
  {
    name: 'run_read_only_query',
    description: 'Run one read-only SELECT and return a bounded summary (no row data by default).',
    riskClass: 'R1',
    engines: ['MYSQL', 'PG', 'SQLITE'],
    mcp: false,
    parameters: objectSchema({
      sql: { type: 'string', maxLength: 10_000 },
      maxRows: { type: 'integer', minimum: 1, maximum: 1000 },
      includeSample: { type: 'boolean' },
    }, ['sql']),
  },
];

/** Adapt a real session (QueryService + metadata) to the runtime's session shape. */
export function bindAgentSession(session: SqlConnectionSession): AgentToolHost['session'] {
  return {
    query: (sql, values, options) => session.query.query(sql, values, options),
    metadata: session.metadata,
  };
}

/** Map internal tool metadata to the OpenAI wire shape used by ai-core. */
export function toModelTools(definitions: readonly ToolDefinition[]) {
  return definitions.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

export function buildAgentTools(host: AgentToolHost): AgentTools {
  const engine = agentEngineOf(host.dbType);
  const target = { engine, session: host.session, sessionReadOnly: host.readOnlySession };

  const execute = async (call: ToolCall, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> => {
    switch (call.function.name) {
      case 'list_schemas':
        return listSchemas(host, engine);
      case 'list_tables':
        return listTables(host);
      case 'describe_table':
        return describeTable(host, String(args.table ?? ''));
      case 'explain_query':
        return explain(host, target, String(args.sql ?? ''), signal);
      case 'run_read_only_query':
        return query(host, target, args, signal);
      default:
        return { content: `Unknown tool: ${call.function.name}`, isError: true, summary: '未知工具' };
    }
  };

  return { definitions: AGENT_TOOL_DEFINITIONS.map((d) => ({ ...d })), execute };
}

async function listSchemas(host: AgentToolHost, engine: AgentEngine): Promise<ToolOutcome> {
  try {
    if (engine === 'PG') {
      const res = await host.session.query('SELECT schema_name FROM information_schema.schemata ORDER BY schema_name');
      const names = (res.rows as Array<{ schema_name?: unknown }>).map((r) => String(r.schema_name ?? '')).filter(Boolean);
      return json({ schemas: names.slice(0, 50) }, `schema ${names.length} 个`);
    }
    if (engine === 'MYSQL') {
      const res = await host.session.query('SHOW DATABASES');
      const names = (res.rows as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0] ?? '')).filter(Boolean);
      return json({ databases: names.slice(0, 50) }, `数据库 ${names.length} 个`);
    }
    return json({ databases: [host.database ?? 'main'] }, '当前数据库');
  } catch (err) {
    return { content: sanitizeToolError('list_schemas', messageOf(err)).data.error, isError: true, summary: '读取 schema 失败' };
  }
}

async function listTables(host: AgentToolHost): Promise<ToolOutcome> {
  try {
    const tables = await host.session.metadata.getTables(host.database, host.schema);
    const envelope = sanitizeMetadata('list_tables', tables.map((t) => ({ name: t.name, ...(t.comment ? { comment: t.comment } : {}) })));
    return { content: bounded(envelope), summary: `表 ${tables.length} 个` };
  } catch (err) {
    return { content: sanitizeToolError('list_tables', messageOf(err)).data.error, isError: true, summary: '读取表清单失败' };
  }
}

async function describeTable(host: AgentToolHost, table: string): Promise<ToolOutcome> {
  if (!table) return { content: 'table is required', isError: true, summary: '缺少表名' };
  try {
    const [columns, indexes, foreignKeys] = await Promise.all([
      host.session.metadata.getColumns(table, host.database, host.schema),
      host.session.metadata.getIndexes(table, host.database, host.schema).catch(() => [] as IndexMeta[]),
      host.session.metadata.getForeignKeys(host.database, host.schema).catch(() => [] as ForeignKeyMeta[]),
    ]);
    if (columns.length === 0) {
      return { content: `Table not found: ${table}`, isError: true, summary: '表不存在' };
    }
    const envelope = sanitizeMetadata('describe_table', [{
      name: table,
      columns: columns.map((c) => ({
        name: c.name,
        type: c.simpleType || c.type,
        nullable: !c.isNotNull,
        primaryKey: c.key === 'PRI',
        ...(c.comment ? { comment: c.comment } : {}),
      })),
      indexes: indexes.map((i) => ({ name: i.name, columns: i.columns, unique: i.isUnique })),
      foreignKeys: foreignKeys.filter((fk) => fk.tableName === table).map((fk) => ({
        columns: [fk.columnName],
        refTable: fk.refTable,
        refColumns: [fk.refColumn],
      })),
    }]);
    return { content: bounded(envelope), summary: `列 ${columns.length} 个、索引 ${indexes.length} 个` };
  } catch (err) {
    return { content: sanitizeToolError('describe_table', messageOf(err)).data.error, isError: true, summary: '读取表结构失败' };
  }
}

async function explain(
  host: AgentToolHost,
  target: { engine: AgentEngine; session: ReadOnlyQuerySession; sessionReadOnly: boolean },
  sql: string,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (!sql.trim()) return { content: 'sql is required', isError: true, summary: '缺少 SQL' };
  // Only plain EXPLAIN: no options, no ANALYZE. SQLite needs QUERY PLAN to be readable.
  const statement = host.dbType === DatabaseType.SQLITE ? `EXPLAIN QUERY PLAN ${sql}` : `EXPLAIN ${sql}`;
  const result = await withCancel(target, signal, (session, token) =>
    explainReadOnly({ ...target, session }, statement, { tool: 'explain_query', ...(token ? { token } : {}) }));
  if (!result.ok) {
    return { content: `EXPLAIN rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`, isError: true, summary: `EXPLAIN 被拒：${result.reason}` };
  }
  const text = result.rows.map((row) => JSON.stringify(row)).join('\n');
  const envelope = sanitizePlanSummary('explain_query', text);
  return { content: bounded(envelope), summary: `计划 ${result.rows.length} 行` };
}

async function query(
  host: AgentToolHost,
  target: { engine: AgentEngine; session: ReadOnlyQuerySession; sessionReadOnly: boolean },
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const sql = String(args.sql ?? '');
  if (!sql.trim()) return { content: 'sql is required', isError: true, summary: '缺少 SQL' };
  const maxRows = typeof args.maxRows === 'number' ? args.maxRows : host.maxRows;
  const includeSample = args.includeSample === true || host.includeSample;
  const result = await withCancel(target, signal, (session, token) =>
    runReadOnlyQuery({ ...target, session }, sql, {
      tool: 'run_read_only_query',
      maxRows,
      ...(token ? { token } : {}),
      sanitize: { includeSample },
    }));
  if (!result.ok) {
    if (result.reason === 'query_failed') {
      return { content: bounded(result.envelope), isError: true, summary: '查询失败' };
    }
    return { content: `Query rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`, isError: true, summary: `被拒绝：${result.reason}` };
  }
  const rows = result.envelope.data.rowCount;
  return { content: bounded(result.envelope), summary: `读取 ${rows} 行${result.truncated ? '（已截断）' : ''}` };
}

/**
 * Bridge the agent's AbortSignal to the query cancel token. The token only
 * cancels this statement, not the shared session.
 */
async function withCancel<T>(
  target: { engine: AgentEngine; session: ReadOnlyQuerySession; sessionReadOnly: boolean },
  signal: AbortSignal,
  fn: (session: ReadOnlyQuerySession, token: { cancel?: () => void } | undefined) => Promise<T>,
): Promise<T> {
  const token: { cancel?: () => void } = {};
  const onAbort = (): void => token.cancel?.();
  if (signal.aborted) throw new Error('aborted');
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fn(target.session, token);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function json(value: unknown, summary: string): ToolOutcome {
  return { content: bounded(value), summary };
}

function bounded(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}