import { describe, expect, it } from 'vitest';
import { defineToolRegistry, guardToolCall, validateArguments } from '../src/index.js';
import type { AgentSettings, ConnectionFacts, ToolCallRequest, ToolDefinition } from '../src/index.js';

const describeTable: ToolDefinition = {
  name: 'describe_table',
  description: 'd',
  riskClass: 'R0',
  engines: ['MYSQL', 'PG', 'SQLITE'],
  mcp: true,
  parameters: {
    type: 'object',
    properties: { table: { type: 'string', maxLength: 64 } },
    required: ['table'],
    additionalProperties: false,
  },
};

const runQuery: ToolDefinition = {
  name: 'run_read_only_query',
  description: 'q',
  riskClass: 'R1',
  engines: ['MYSQL', 'PG', 'SQLITE'],
  mcp: true,
  parameters: {
    type: 'object',
    properties: {
      sql: { type: 'string', maxLength: 10_000 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      includeSample: { type: 'boolean' },
      order: { type: 'string', enum: ['asc', 'desc'] },
    },
    required: ['sql'],
    additionalProperties: false,
  },
};

const proposeWrite: ToolDefinition = {
  name: 'propose_write',
  description: 'w',
  riskClass: 'W2',
  engines: ['MYSQL', 'PG', 'SQLITE'],
  mcp: false,
  parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'], additionalProperties: false },
};

const registry = defineToolRegistry([describeTable, runQuery, proposeWrite]);

const settings: AgentSettings = {
  agentEnabled: true,
  allowWrites: false,
  allowDdl: false,
  allowProduction: false,
  mcpEnabled: true,
  mcpAllowedConnections: ['c1'],
};
const connection: ConnectionFacts = { dialect: 'PG', production: false, readOnly: false };

const call = (over: Partial<ToolCallRequest>): ToolCallRequest => ({
  surface: 'agent',
  toolName: 'describe_table',
  args: { table: 'orders' },
  connectionId: 'c1',
  connection,
  settings,
  ...over,
});

describe('guardToolCall', () => {
  it('allows a registered tool with valid arguments', () => {
    expect(guardToolCall(registry, call({}))).toMatchObject({ allowed: true, args: { table: 'orders' }, requiresApproval: false });
  });

  it('rejects unknown tools, including host-only executors', () => {
    expect(guardToolCall(registry, call({ toolName: 'apply_write' }))).toEqual({ allowed: false, reason: 'unknown_tool', detail: 'apply_write' });
  });

  it('rejects host-reserved arguments regardless of case', () => {
    for (const key of ['connectionId', 'database', 'schema', 'target', 'approvalNonce', 'proposalId', 'ConnectionId']) {
      const r = guardToolCall(registry, call({ args: { table: 'orders', [key]: 'x' } }));
      expect(r, key).toEqual({ allowed: false, reason: 'reserved_argument', detail: key });
    }
  });

  it('rejects unknown, missing and mistyped arguments', () => {
    expect(guardToolCall(registry, call({ args: { table: 'orders', extra: 1 } })))
      .toMatchObject({ allowed: false, reason: 'invalid_arguments', detail: 'unknown argument: extra' });
    expect(guardToolCall(registry, call({ args: {} })))
      .toMatchObject({ allowed: false, reason: 'invalid_arguments', detail: 'missing argument: table' });
    expect(guardToolCall(registry, call({ args: { table: 1 } })))
      .toMatchObject({ allowed: false, reason: 'invalid_arguments' });
    expect(guardToolCall(registry, call({ args: 'orders' })))
      .toMatchObject({ allowed: false, reason: 'invalid_arguments' });
    expect(guardToolCall(registry, call({ args: ['orders'] })))
      .toMatchObject({ allowed: false, reason: 'invalid_arguments' });
  });

  it('applies policy after argument checks', () => {
    expect(guardToolCall(registry, call({ toolName: 'propose_write', args: { sql: 'UPDATE t SET a = 1' } })))
      .toEqual({ allowed: false, reason: 'writes_disabled' });
    expect(guardToolCall(registry, call({ toolName: 'propose_write', args: { sql: 'UPDATE t SET a = 1' }, settings: { ...settings, allowWrites: true } })))
      .toMatchObject({ allowed: true, requiresApproval: true });
    expect(guardToolCall(registry, call({ surface: 'mcp', toolName: 'propose_write', args: { sql: 'x' } })))
      .toEqual({ allowed: false, reason: 'mcp_tool_not_allowed' });
    expect(guardToolCall(registry, call({ surface: 'mcp', connectionId: 'c9' })))
      .toEqual({ allowed: false, reason: 'mcp_connection_not_allowed' });
  });

  it('returns a copy of the arguments, not the original object', () => {
    const args = { table: 'orders' };
    const r = guardToolCall(registry, call({ args }));
    if (!r.allowed) throw new Error('expected allowed');
    expect(r.args).toEqual(args);
    expect(r.args).not.toBe(args);
  });
});

describe('validateArguments', () => {
  const schema = runQuery.parameters;

  it('checks integer bounds, enums and string length', () => {
    expect(validateArguments(schema, { sql: 'SELECT 1', limit: 10, includeSample: false, order: 'asc' })).toMatchObject({ ok: true });
    expect(validateArguments(schema, { sql: 'SELECT 1', limit: 1.5 })).toMatchObject({ ok: false, detail: 'limit must be an integer' });
    expect(validateArguments(schema, { sql: 'SELECT 1', limit: 0 })).toMatchObject({ ok: false, detail: 'limit is below minimum 1' });
    expect(validateArguments(schema, { sql: 'SELECT 1', limit: Number.NaN })).toMatchObject({ ok: false });
    expect(validateArguments(schema, { sql: 'SELECT 1', order: 'up' })).toMatchObject({ ok: false, detail: 'order is not an allowed value' });
    expect(validateArguments(schema, { sql: 'x'.repeat(10_001) })).toMatchObject({ ok: false });
    expect(validateArguments(schema, { sql: 'SELECT 1', includeSample: 'yes' })).toMatchObject({ ok: false });
  });

  it('refuses schemas outside the supported subset', () => {
    const base = { type: 'object', properties: {}, additionalProperties: false };
    expect(validateArguments({ ...base, type: 'array' }, {})).toMatchObject({ ok: false, reason: 'unsupported_schema' });
    expect(validateArguments({ ...base, additionalProperties: true }, {})).toMatchObject({ ok: false, reason: 'unsupported_schema' });
    expect(validateArguments({ ...base, properties: { nested: { type: 'object' } } }, {})).toMatchObject({ ok: false, reason: 'unsupported_schema' });
    expect(validateArguments({ ...base, properties: { list: { type: 'array' } } }, {})).toMatchObject({ ok: false, reason: 'unsupported_schema' });
    expect(validateArguments({ ...base, properties: { schema: { type: 'string' } } }, {})).toMatchObject({ ok: false, reason: 'unsupported_schema' });
    expect(validateArguments({ ...base, required: 'sql' }, {})).toMatchObject({ ok: false, reason: 'unsupported_schema' });
  });

  it('treats undefined arguments as an empty object', () => {
    expect(validateArguments({ type: 'object', properties: {}, additionalProperties: false }, undefined)).toEqual({ ok: true, args: {} });
  });
});
