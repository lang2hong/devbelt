import { describe, expect, it } from 'vitest';
import { ToolRegistryError, defineToolRegistry, evaluatePolicy, mcpTools } from '../src/index.js';
import type { AgentSettings, ConnectionFacts, ToolDefinition } from '../src/index.js';

const tool = (over: Partial<ToolDefinition>): ToolDefinition => ({
  name: 'describe_table',
  description: 'd',
  riskClass: 'R0',
  engines: ['MYSQL', 'PG', 'SQLITE'],
  mcp: true,
  parameters: {},
  ...over,
});

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  agentEnabled: true,
  allowWrites: false,
  allowDdl: false,
  allowProduction: false,
  mcpEnabled: true,
  mcpAllowedConnections: ['c1'],
  ...over,
});

const conn = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  dialect: 'MYSQL',
  production: false,
  readOnly: false,
  ...over,
});

describe('defineToolRegistry', () => {
  it('rejects write tools exposed to MCP', () => {
    expect(() => defineToolRegistry([tool({ name: 'propose_write', riskClass: 'W2', mcp: true })]))
      .toThrow(ToolRegistryError);
    expect(() => defineToolRegistry([tool({ name: 'export_masked', riskClass: 'R2', mcp: true })]))
      .toThrow(ToolRegistryError);
  });

  it('rejects duplicate and malformed names and empty engine lists', () => {
    expect(() => defineToolRegistry([tool({}), tool({})])).toThrow(/duplicate/);
    expect(() => defineToolRegistry([tool({ name: 'Bad-Name' })])).toThrow(/invalid tool name/);
    expect(() => defineToolRegistry([tool({ engines: [] })])).toThrow(/engines/);
  });

  it('lists only read tools flagged for MCP', () => {
    const registry = defineToolRegistry([
      tool({ name: 'describe_table' }),
      tool({ name: 'run_read_only_query', riskClass: 'R1' }),
      tool({ name: 'list_private', mcp: false }),
      tool({ name: 'propose_write', riskClass: 'W2', mcp: false }),
    ]);
    expect(mcpTools(registry).map((t) => t.name)).toEqual(['describe_table', 'run_read_only_query']);
  });

  it('freezes definitions', () => {
    const registry = defineToolRegistry([tool({})]);
    expect(Object.isFrozen(registry.get('describe_table'))).toBe(true);
  });
});

describe('evaluatePolicy — MCP', () => {
  const base = { surface: 'mcp' as const, connectionId: 'c1' };

  it('allows read tools on whitelisted non-production connections without approval', () => {
    expect(evaluatePolicy({ ...base, tool: tool({}), connection: conn(), settings: settings() }))
      .toEqual({ allowed: true, requiresApproval: false });
  });

  it('never allows write or export classes, even if a definition claims mcp', () => {
    for (const riskClass of ['R2', 'W2', 'W3'] as const) {
      const decision = evaluatePolicy({ ...base, tool: tool({ riskClass, mcp: true }), connection: conn(), settings: settings({ allowWrites: true, allowDdl: true, allowProduction: true }) });
      expect(decision).toEqual({ allowed: false, reason: 'mcp_tool_not_allowed' });
    }
  });

  it('denies when MCP is off, the connection is not whitelisted, or it is production', () => {
    expect(evaluatePolicy({ ...base, tool: tool({}), connection: conn(), settings: settings({ mcpEnabled: false }) }))
      .toEqual({ allowed: false, reason: 'mcp_disabled' });
    expect(evaluatePolicy({ ...base, connectionId: 'c2', tool: tool({}), connection: conn(), settings: settings() }))
      .toEqual({ allowed: false, reason: 'mcp_connection_not_allowed' });
    expect(evaluatePolicy({ ...base, tool: tool({}), connection: conn({ production: true }), settings: settings() }))
      .toEqual({ allowed: false, reason: 'mcp_production_denied' });
  });

  it('denies tools not flagged for MCP', () => {
    expect(evaluatePolicy({ ...base, tool: tool({ mcp: false }), connection: conn(), settings: settings() }))
      .toEqual({ allowed: false, reason: 'mcp_tool_not_allowed' });
  });
});

describe('evaluatePolicy — agent', () => {
  const base = { surface: 'agent' as const, connectionId: 'c1' };

  it('requires the agent switch', () => {
    expect(evaluatePolicy({ ...base, tool: tool({}), connection: conn(), settings: settings({ agentEnabled: false }) }))
      .toEqual({ allowed: false, reason: 'agent_disabled' });
  });

  it('runs reads without approval except R1 on production', () => {
    expect(evaluatePolicy({ ...base, tool: tool({ riskClass: 'R1' }), connection: conn(), settings: settings() }))
      .toEqual({ allowed: true, requiresApproval: false });
    expect(evaluatePolicy({ ...base, tool: tool({ riskClass: 'R1' }), connection: conn({ production: true }), settings: settings() }))
      .toEqual({ allowed: true, requiresApproval: true });
    expect(evaluatePolicy({ ...base, tool: tool({ riskClass: 'R0' }), connection: conn({ production: true }), settings: settings() }))
      .toEqual({ allowed: true, requiresApproval: false });
  });

  it('gates W2 and W3 on settings, read-only and production', () => {
    const w2 = tool({ name: 'propose_write', riskClass: 'W2', mcp: false });
    const w3 = tool({ name: 'propose_ddl', riskClass: 'W3', mcp: false });
    expect(evaluatePolicy({ ...base, tool: w2, connection: conn(), settings: settings() }))
      .toEqual({ allowed: false, reason: 'writes_disabled' });
    expect(evaluatePolicy({ ...base, tool: w3, connection: conn(), settings: settings({ allowWrites: true }) }))
      .toEqual({ allowed: false, reason: 'ddl_disabled' });
    expect(evaluatePolicy({ ...base, tool: w2, connection: conn({ readOnly: true }), settings: settings({ allowWrites: true }) }))
      .toEqual({ allowed: false, reason: 'read_only_connection' });
    expect(evaluatePolicy({ ...base, tool: w2, connection: conn({ production: true }), settings: settings({ allowWrites: true }) }))
      .toEqual({ allowed: false, reason: 'production_denied' });
    expect(evaluatePolicy({ ...base, tool: w2, connection: conn({ production: true }), settings: settings({ allowWrites: true, allowProduction: true }) }))
      .toEqual({ allowed: true, requiresApproval: true });
    expect(evaluatePolicy({ ...base, tool: w3, connection: conn(), settings: settings({ allowDdl: true }) }))
      .toEqual({ allowed: true, requiresApproval: true });
  });

  it('always requires approval for exports', () => {
    expect(evaluatePolicy({ ...base, tool: tool({ name: 'export_masked', riskClass: 'R2', mcp: false }), connection: conn(), settings: settings() }))
      .toEqual({ allowed: true, requiresApproval: true });
  });

  it('rejects unsupported engines first', () => {
    expect(evaluatePolicy({ ...base, tool: tool({ engines: ['PG'] }), connection: conn({ dialect: 'SQLITE' }), settings: settings() }))
      .toEqual({ allowed: false, reason: 'engine_unsupported' });
  });
});

describe('evaluatePolicy — masking', () => {
  it('never allows write classes and requires approval for exports', () => {
    const base = { surface: 'masking' as const, connectionId: 'c1', connection: conn(), settings: settings({ agentEnabled: false }) };
    expect(evaluatePolicy({ ...base, tool: tool({ riskClass: 'W2', mcp: false }) }))
      .toEqual({ allowed: false, reason: 'surface_not_allowed' });
    expect(evaluatePolicy({ ...base, tool: tool({ riskClass: 'R2', mcp: false }) }))
      .toEqual({ allowed: true, requiresApproval: true });
    expect(evaluatePolicy({ ...base, tool: tool({ riskClass: 'R0' }) }))
      .toEqual({ allowed: true, requiresApproval: false });
  });
});
