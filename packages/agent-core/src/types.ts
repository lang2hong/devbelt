/** SQL engines the agent runtime can target. */
export type AgentEngine = 'MYSQL' | 'PG' | 'SQLITE';

/**
 * Risk classes.
 * - R0: metadata / plain EXPLAIN
 * - R1: bounded read-only query
 * - R2: data export / egress
 * - W2: DML write
 * - W3: DDL / destructive
 */
export type RiskClass = 'R0' | 'R1' | 'R2' | 'W2' | 'W3';

/** Where a tool call originates. */
export type AgentSurface = 'agent' | 'mcp' | 'masking';

/** Whether a call is a read or one of the approval-gated classes. */
export const READ_CLASSES: readonly RiskClass[] = ['R0', 'R1'];
export const WRITE_CLASSES: readonly RiskClass[] = ['W2', 'W3'];

/** Model-visible tool contract. Execution of approved writes is never a model tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  riskClass: RiskClass;
  engines: readonly AgentEngine[];
  /** Exposed to MCP clients. Only R0 / R1 tools may set this. */
  mcp: boolean;
  /** JSON Schema of the arguments; unknown fields are rejected by the host. */
  parameters: Record<string, unknown>;
}

/**
 * Database target, always injected by the host. Models and MCP clients
 * never supply it.
 */
export interface TargetBinding {
  connectionId: string;
  database?: string;
  schema?: string;
  dialect: AgentEngine;
}

/** Connection facts the policy needs, resolved by the host. */
export interface ConnectionFacts {
  dialect: AgentEngine;
  production: boolean;
  readOnly: boolean;
}

/** User settings that gate agent capabilities. */
export interface AgentSettings {
  agentEnabled: boolean;
  allowWrites: boolean;
  allowDdl: boolean;
  allowProduction: boolean;
  mcpEnabled: boolean;
  /** Connection ids the user allowed MCP clients to use. */
  mcpAllowedConnections: readonly string[];
}
