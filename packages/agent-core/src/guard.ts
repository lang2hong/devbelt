import { evaluatePolicy } from './policy.js';
import type { PolicyDecision, PolicyDenyReason } from './policy.js';
import type { AgentSettings, AgentSurface, ConnectionFacts, ToolDefinition } from './types.js';

/**
 * Argument names the model or an MCP client may never supply. The target and
 * approval state are injected by the host.
 */
export const RESERVED_ARGUMENTS: readonly string[] = Object.freeze([
  'connectionId',
  'connection',
  'database',
  'schema',
  'dialect',
  'target',
  'proposalId',
  'approvalNonce',
  'nonce',
]);

export type GuardDenyReason =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'reserved_argument'
  | 'unsupported_schema'
  | PolicyDenyReason;

export type GuardResult =
  | { allowed: true; tool: ToolDefinition; args: Record<string, unknown>; requiresApproval: boolean }
  | { allowed: false; reason: GuardDenyReason; detail?: string };

export interface ToolCallRequest {
  surface: AgentSurface;
  toolName: string;
  /** Raw arguments from the model or MCP client; untrusted. */
  args: unknown;
  /** Resolved by the host from its own state, never from the request. */
  connectionId: string;
  connection: ConnectionFacts;
  settings: AgentSettings;
}

type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean';
const PRIMITIVES: readonly PrimitiveType[] = ['string', 'number', 'integer', 'boolean'];
const RESERVED = new Set(RESERVED_ARGUMENTS.map((n) => n.toLowerCase()));

/**
 * Validate one tool call before anything runs: tool registered, arguments match
 * a flat JSON Schema subset, no host-reserved names, then policy. Called on
 * every call, so earlier model output cannot widen what is allowed.
 */
export function guardToolCall(registry: ReadonlyMap<string, ToolDefinition>, request: ToolCallRequest): GuardResult {
  const tool = registry.get(request.toolName);
  if (!tool) return { allowed: false, reason: 'unknown_tool', detail: request.toolName };

  const parsed = validateArguments(tool.parameters, request.args);
  if (!parsed.ok) return { allowed: false, reason: parsed.reason, detail: parsed.detail };

  const decision: PolicyDecision = evaluatePolicy({
    surface: request.surface,
    tool,
    connectionId: request.connectionId,
    connection: request.connection,
    settings: request.settings,
  });
  if (!decision.allowed) return { allowed: false, reason: decision.reason };
  return { allowed: true, tool, args: parsed.args, requiresApproval: decision.requiresApproval };
}

type ValidateResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: 'invalid_arguments' | 'reserved_argument' | 'unsupported_schema'; detail: string };

/**
 * Supported subset: `{ type: 'object', properties, required, additionalProperties: false }`
 * with primitive properties (`string` / `number` / `integer` / `boolean`,
 * optional `enum`, `maxLength`, `minimum`, `maximum`). Anything else is
 * rejected rather than half-validated.
 */
export function validateArguments(schema: Record<string, unknown>, args: unknown): ValidateResult {
  if (schema.type !== 'object') return unsupported('schema type must be object');
  if (schema.additionalProperties !== false) return unsupported('schema must set additionalProperties: false');
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  if (typeof properties !== 'object' || Array.isArray(properties)) return unsupported('properties must be an object');
  const required = (schema.required ?? []) as unknown;
  if (!Array.isArray(required) || !required.every((r) => typeof r === 'string')) return unsupported('required must be a string array');

  for (const [name, prop] of Object.entries(properties)) {
    if (RESERVED.has(name.toLowerCase())) return unsupported(`schema declares reserved argument: ${name}`);
    if (!prop || !PRIMITIVES.includes(prop.type as PrimitiveType)) return unsupported(`property ${name} must be a primitive type`);
  }

  const input = args === undefined ? {} : args;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalidArgs('arguments must be an object');
  const record = input as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (RESERVED.has(key.toLowerCase())) return { ok: false, reason: 'reserved_argument', detail: key };
    if (!Object.prototype.hasOwnProperty.call(properties, key)) return invalidArgs(`unknown argument: ${key}`);
  }
  for (const name of required as string[]) {
    if (!(name in record) || record[name] === undefined) return invalidArgs(`missing argument: ${name}`);
  }

  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    const prop = properties[name]!;
    const error = checkPrimitive(name, prop, value);
    if (error) return invalidArgs(error);
    out[name] = value;
  }
  return { ok: true, args: out };
}

function checkPrimitive(name: string, prop: Record<string, unknown>, value: unknown): string | undefined {
  const type = prop.type as PrimitiveType;
  if (type === 'string') {
    if (typeof value !== 'string') return `${name} must be a string`;
    if (typeof prop.maxLength === 'number' && value.length > prop.maxLength) return `${name} exceeds maxLength ${prop.maxLength}`;
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return `${name} must be a boolean`;
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a finite number`;
    if (type === 'integer' && !Number.isInteger(value)) return `${name} must be an integer`;
    if (typeof prop.minimum === 'number' && value < prop.minimum) return `${name} is below minimum ${prop.minimum}`;
    if (typeof prop.maximum === 'number' && value > prop.maximum) return `${name} is above maximum ${prop.maximum}`;
  }
  if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return `${name} is not an allowed value`;
  return undefined;
}

function unsupported(detail: string): ValidateResult {
  return { ok: false, reason: 'unsupported_schema', detail };
}

function invalidArgs(detail: string): ValidateResult {
  return { ok: false, reason: 'invalid_arguments', detail };
}
