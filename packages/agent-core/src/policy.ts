import { READ_CLASSES, WRITE_CLASSES } from './types.js';
import type { AgentSettings, AgentSurface, ConnectionFacts, RiskClass, ToolDefinition } from './types.js';

export type PolicyDenyReason =
  | 'agent_disabled'
  | 'mcp_disabled'
  | 'mcp_tool_not_allowed'
  | 'mcp_connection_not_allowed'
  | 'mcp_production_denied'
  | 'surface_not_allowed'
  | 'engine_unsupported'
  | 'read_only_connection'
  | 'writes_disabled'
  | 'ddl_disabled'
  | 'production_denied';

export type PolicyDecision =
  | { allowed: true; requiresApproval: boolean }
  | { allowed: false; reason: PolicyDenyReason };

export interface PolicyInput {
  surface: AgentSurface;
  tool: ToolDefinition;
  connectionId: string;
  connection: ConnectionFacts;
  settings: AgentSettings;
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

const isRead = (c: RiskClass): boolean => READ_CLASSES.includes(c);
const isWrite = (c: RiskClass): boolean => WRITE_CLASSES.includes(c);

/**
 * Validate tool definitions once at startup. MCP may only expose read
 * classes; this is checked here and again on every call.
 */
export function defineToolRegistry(tools: readonly ToolDefinition[]): ReadonlyMap<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new ToolRegistryError(`invalid tool name: ${tool.name}`);
    if (registry.has(tool.name)) throw new ToolRegistryError(`duplicate tool: ${tool.name}`);
    if (tool.engines.length === 0) throw new ToolRegistryError(`tool without engines: ${tool.name}`);
    if (tool.mcp && !isRead(tool.riskClass)) {
      throw new ToolRegistryError(`tool ${tool.name} (${tool.riskClass}) cannot be exposed to MCP`);
    }
    registry.set(tool.name, Object.freeze({ ...tool }));
  }
  return registry;
}

/** Tools an MCP client may see: read classes flagged for MCP. */
export function mcpTools(registry: ReadonlyMap<string, ToolDefinition>): ToolDefinition[] {
  return [...registry.values()].filter((t) => t.mcp && isRead(t.riskClass));
}

/**
 * Decide whether a tool call may run and whether it needs explicit approval.
 * Pure function: the host re-evaluates it on every call, so model output
 * cannot change the outcome.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { surface, tool, connectionId, connection, settings } = input;
  const risk = tool.riskClass;

  if (!tool.engines.includes(connection.dialect)) return deny('engine_unsupported');

  if (surface === 'mcp') {
    if (!settings.mcpEnabled) return deny('mcp_disabled');
    if (!tool.mcp || !isRead(risk)) return deny('mcp_tool_not_allowed');
    if (!settings.mcpAllowedConnections.includes(connectionId)) return deny('mcp_connection_not_allowed');
    if (connection.production) return deny('mcp_production_denied');
    return { allowed: true, requiresApproval: false };
  }

  if (surface === 'masking') {
    // Masking reads and exports; it never writes to the database.
    if (isWrite(risk)) return deny('surface_not_allowed');
    return { allowed: true, requiresApproval: risk === 'R2' };
  }

  if (!settings.agentEnabled) return deny('agent_disabled');

  if (isRead(risk)) {
    // Read-only queries never auto-run on production connections.
    return { allowed: true, requiresApproval: risk === 'R1' && connection.production };
  }
  if (risk === 'R2') return { allowed: true, requiresApproval: true };

  if (connection.readOnly) return deny('read_only_connection');
  if (risk === 'W2' && !settings.allowWrites) return deny('writes_disabled');
  if (risk === 'W3' && !settings.allowDdl) return deny('ddl_disabled');
  if (connection.production && !settings.allowProduction) return deny('production_denied');
  return { allowed: true, requiresApproval: true };
}

function deny(reason: PolicyDenyReason): PolicyDecision {
  return { allowed: false, reason };
}
