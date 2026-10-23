import type { AgentSurface, RiskClass, TargetBinding } from './types.js';

/** Ledger states, in the order a write proposal moves through them. */
export type LedgerState = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'REVOKED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export const TERMINAL_STATES: readonly LedgerState[] = ['REJECTED', 'REVOKED', 'SUCCEEDED', 'FAILED', 'UNKNOWN'];

/** Allowed state transitions. `undefined` is the state before the first event. */
const TRANSITIONS: Record<LedgerState | 'NONE', readonly LedgerState[]> = {
  NONE: ['PROPOSED'],
  PROPOSED: ['APPROVED', 'REJECTED', 'REVOKED'],
  APPROVED: ['EXECUTING', 'REVOKED'],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
  REJECTED: [],
  REVOKED: [],
  SUCCEEDED: [],
  FAILED: [],
  UNKNOWN: [],
};

/**
 * One persisted line. It carries hashes and counters only: no SQL text,
 * result rows, parameter values, credentials or nonces.
 */
export interface LedgerEvent {
  v: 1;
  seq: number;
  at: number;
  proposalId: string;
  state: LedgerState;
  surface: AgentSurface;
  riskClass: RiskClass;
  target: TargetBinding;
  sqlHash: string;
  tool?: string;
  clientId?: string;
  estimatedRows?: number;
  affectedRows?: number;
  durationMs?: number;
  errorCode?: string;
}

/** Fields the caller supplies; `v`, `seq` and `at` are assigned by the ledger. */
export type LedgerEventInput = Omit<LedgerEvent, 'v' | 'seq' | 'at'>;

export interface ProposalLedgerState {
  proposalId: string;
  state: LedgerState;
  first: LedgerEvent;
  last: LedgerEvent;
}

export interface ExecutionLedger {
  /** Persist an event. Throws if it cannot be made durable; callers must then block W2/W3. */
  append(event: LedgerEventInput): Promise<LedgerEvent>;
  /** Read all events in order. */
  load(): Promise<LedgerEvent[]>;
  /** Mark `EXECUTING` entries without a terminal event as `UNKNOWN`. Returns the new events. */
  recoverInterrupted(): Promise<LedgerEvent[]>;
}

export type LedgerErrorCode = 'invalid_event' | 'invalid_transition' | 'corrupt' | 'locked' | 'io';

export class LedgerError extends Error {
  readonly cause?: unknown;

  constructor(readonly code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'LedgerError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const STATES: readonly LedgerState[] = Object.keys(TRANSITIONS).filter((s) => s !== 'NONE') as LedgerState[];
const RISKS: readonly RiskClass[] = ['R0', 'R1', 'R2', 'W2', 'W3'];
const SURFACES: readonly AgentSurface[] = ['agent', 'mcp', 'masking'];
const ALLOWED_KEYS = new Set([
  'v', 'seq', 'at', 'proposalId', 'state', 'surface', 'riskClass', 'target', 'sqlHash',
  'tool', 'clientId', 'estimatedRows', 'affectedRows', 'durationMs', 'errorCode',
]);
const TARGET_KEYS = new Set(['connectionId', 'database', 'schema', 'dialect']);

export function canTransition(from: LedgerState | undefined, to: LedgerState): boolean {
  return TRANSITIONS[from ?? 'NONE'].includes(to);
}

/** Replay events into the latest state per proposal, enforcing transitions. */
export function reduceLedger(events: readonly LedgerEvent[]): Map<string, ProposalLedgerState> {
  const out = new Map<string, ProposalLedgerState>();
  let lastSeq = 0;
  for (const event of events) {
    if (event.seq <= lastSeq) throw new LedgerError('corrupt', `non-increasing seq ${event.seq} after ${lastSeq}`);
    lastSeq = event.seq;
    const current = out.get(event.proposalId);
    if (!canTransition(current?.state, event.state)) {
      throw new LedgerError('invalid_transition', `${event.proposalId}: ${current?.state ?? 'NONE'} -> ${event.state}`);
    }
    // A proposal's binding is immutable: later events must repeat it exactly.
    if (current && !sameBinding(current.first, event)) {
      throw new LedgerError('invalid_event', `${event.proposalId}: binding changed after PROPOSED`);
    }
    out.set(event.proposalId, current
      ? { ...current, state: event.state, last: event }
      : { proposalId: event.proposalId, state: event.state, first: event, last: event });
  }
  return out;
}

/** Validate shape and reject unknown fields so nothing sensitive is persisted by accident. */
export function validateLedgerEvent(value: unknown): LedgerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('event is not an object');
  const e = value as Record<string, unknown>;
  for (const key of Object.keys(e)) if (!ALLOWED_KEYS.has(key)) throw invalid(`unknown field: ${key}`);
  if (e.v !== 1) throw invalid('unsupported version');
  if (!isPositiveInt(e.seq)) throw invalid('seq must be a positive integer');
  if (!isNonNegative(e.at)) throw invalid('at must be a timestamp');
  if (!nonEmpty(e.proposalId)) throw invalid('proposalId is required');
  if (!STATES.includes(e.state as LedgerState)) throw invalid('invalid state');
  if (!SURFACES.includes(e.surface as AgentSurface)) throw invalid('invalid surface');
  if (!RISKS.includes(e.riskClass as RiskClass)) throw invalid('invalid riskClass');
  if (typeof e.sqlHash !== 'string' || !/^[0-9a-f]{64}$/.test(e.sqlHash)) throw invalid('sqlHash must be sha256 hex');
  validateTarget(e.target);
  for (const key of ['tool', 'clientId', 'errorCode'] as const) {
    if (e[key] !== undefined && !nonEmpty(e[key])) throw invalid(`${key} must be a non-empty string`);
  }
  for (const key of ['estimatedRows', 'affectedRows', 'durationMs'] as const) {
    if (e[key] !== undefined && !isNonNegative(e[key])) throw invalid(`${key} must be a non-negative number`);
  }
  return e as unknown as LedgerEvent;
}

function validateTarget(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('target is required');
  const t = value as Record<string, unknown>;
  for (const key of Object.keys(t)) if (!TARGET_KEYS.has(key)) throw invalid(`unknown target field: ${key}`);
  if (!nonEmpty(t.connectionId)) throw invalid('target.connectionId is required');
  if (!['MYSQL', 'PG', 'SQLITE'].includes(t.dialect as string)) throw invalid('target.dialect is invalid');
  for (const key of ['database', 'schema'] as const) {
    if (t[key] !== undefined && typeof t[key] !== 'string') throw invalid(`target.${key} must be a string`);
  }
}

function sameBinding(a: LedgerEvent, b: LedgerEvent): boolean {
  return a.sqlHash === b.sqlHash
    && a.riskClass === b.riskClass
    && a.surface === b.surface
    && a.target.connectionId === b.target.connectionId
    && a.target.dialect === b.target.dialect
    && (a.target.database ?? '') === (b.target.database ?? '')
    && (a.target.schema ?? '') === (b.target.schema ?? '');
}

function invalid(message: string): LedgerError {
  return new LedgerError('invalid_event', message);
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isNonNegative = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPositiveInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0;
