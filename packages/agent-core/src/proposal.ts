import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PolicyDecision } from './policy.js';
import type { TargetBinding } from './types.js';

export type WriteRiskClass = 'W2' | 'W3';

export type ProposalStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/** Outcome of the restricted dry-run shown on the approval card. */
export type DryRunOutcome = 'rolled_back' | 'static_only' | 'failed';

export interface Proposal {
  readonly proposalId: string;
  readonly target: Readonly<TargetBinding>;
  readonly normalizedSql: string;
  /** The exact SQL that will run; object names are fully qualified. */
  readonly fullyQualifiedSql: string;
  /** sha256 over the target binding and `fullyQualifiedSql`. */
  readonly sqlHash: string;
  readonly riskClass: WriteRiskClass;
  /** Estimate only; undefined means unknown. */
  readonly estimatedRows?: number;
  readonly dryRun: DryRunOutcome;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: ProposalStatus;
  /** Host-only. Never part of a view sent to the model, webview or MCP. */
  readonly approvalNonceHash?: string;
}

/** What the model, webview and MCP may see. */
export type ProposalView = Omit<Proposal, 'approvalNonceHash'>;

export interface CreateProposalInput {
  target: TargetBinding;
  normalizedSql: string;
  fullyQualifiedSql: string;
  riskClass: WriteRiskClass;
  estimatedRows?: number;
  dryRun: DryRunOutcome;
}

export interface CreateProposalOptions {
  now: number;
  ttlMs: number;
  proposalId?: string;
}

export type ProposalErrorCode =
  | 'invalid_input'
  | 'invalid_transition'
  | 'expired';

export class ProposalError extends Error {
  constructor(readonly code: ProposalErrorCode, message: string) {
    super(message);
    this.name = 'ProposalError';
  }
}

export type AuthorizeDenyReason =
  | 'not_approved'
  | 'already_executed'
  | 'expired'
  | 'nonce_mismatch'
  | 'target_mismatch'
  | 'sql_mismatch'
  | 'policy_denied';

export interface AuthorizeRequest {
  nonce: string;
  target: TargetBinding;
  fullyQualifiedSql: string;
  /** Policy re-evaluated by the host right before execution. */
  policy: PolicyDecision;
}

export type AuthorizeResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: AuthorizeDenyReason };

export function computeSqlHash(target: TargetBinding, fullyQualifiedSql: string): string {
  const canonical = JSON.stringify([
    target.dialect,
    target.connectionId,
    target.database ?? '',
    target.schema ?? '',
    fullyQualifiedSql,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createProposal(input: CreateProposalInput, options: CreateProposalOptions): Proposal {
  if (input.riskClass !== 'W2' && input.riskClass !== 'W3') {
    throw new ProposalError('invalid_input', `proposals are only for W2/W3, got ${String(input.riskClass)}`);
  }
  if (!input.target.connectionId) throw new ProposalError('invalid_input', 'connectionId is required');
  if (!input.fullyQualifiedSql.trim()) throw new ProposalError('invalid_input', 'fullyQualifiedSql is empty');
  if (!(options.ttlMs > 0)) throw new ProposalError('invalid_input', 'ttlMs must be positive');
  if (input.estimatedRows !== undefined && !(Number.isFinite(input.estimatedRows) && input.estimatedRows >= 0)) {
    throw new ProposalError('invalid_input', 'estimatedRows must be a non-negative number');
  }
  const target: TargetBinding = Object.freeze({ ...input.target });
  return Object.freeze({
    proposalId: options.proposalId ?? randomUUID(),
    target,
    normalizedSql: input.normalizedSql,
    fullyQualifiedSql: input.fullyQualifiedSql,
    sqlHash: computeSqlHash(target, input.fullyQualifiedSql),
    riskClass: input.riskClass,
    ...(input.estimatedRows !== undefined ? { estimatedRows: input.estimatedRows } : {}),
    dryRun: input.dryRun,
    createdAt: options.now,
    expiresAt: options.now + options.ttlMs,
    status: 'proposed',
  });
}

export function isExpired(proposal: Proposal, now: number): boolean {
  return now >= proposal.expiresAt;
}

/**
 * Approve a proposal. Returns the one-time nonce to the host caller only;
 * the proposal keeps just its hash.
 */
export function approveProposal(
  proposal: Proposal,
  now: number,
  nonce: string = randomBytes(32).toString('base64url'),
): { proposal: Proposal; nonce: string } {
  requireStatus(proposal, ['proposed']);
  if (isExpired(proposal, now)) throw new ProposalError('expired', 'proposal expired before approval');
  if (!nonce) throw new ProposalError('invalid_input', 'nonce is empty');
  return { proposal: withStatus(proposal, 'approved', { approvalNonceHash: digest(nonce) }), nonce };
}

export function rejectProposal(proposal: Proposal): Proposal {
  requireStatus(proposal, ['proposed']);
  return withStatus(proposal, 'rejected');
}

export function revokeProposal(proposal: Proposal): Proposal {
  requireStatus(proposal, ['proposed', 'approved']);
  return withStatus(proposal, 'revoked');
}

/**
 * Check every binding before execution and move the proposal to `executing`.
 * The caller must persist the `executing` ledger event before running SQL.
 */
export function authorizeExecution(proposal: Proposal, request: AuthorizeRequest, now: number): AuthorizeResult {
  if (['executing', 'succeeded', 'failed', 'unknown'].includes(proposal.status)) {
    return { ok: false, reason: 'already_executed' };
  }
  if (proposal.status !== 'approved' || !proposal.approvalNonceHash) return { ok: false, reason: 'not_approved' };
  if (isExpired(proposal, now)) return { ok: false, reason: 'expired' };
  if (!safeEqualHex(digest(request.nonce), proposal.approvalNonceHash)) return { ok: false, reason: 'nonce_mismatch' };
  if (!sameTarget(proposal.target, request.target)) return { ok: false, reason: 'target_mismatch' };
  if (computeSqlHash(request.target, request.fullyQualifiedSql) !== proposal.sqlHash) {
    return { ok: false, reason: 'sql_mismatch' };
  }
  if (!request.policy.allowed) return { ok: false, reason: 'policy_denied' };
  // The nonce is single-use: drop its hash once execution starts.
  return { ok: true, proposal: withStatus(proposal, 'executing', { approvalNonceHash: undefined }) };
}

export function completeProposal(proposal: Proposal, outcome: 'succeeded' | 'failed' | 'unknown'): Proposal {
  requireStatus(proposal, ['executing']);
  return withStatus(proposal, outcome);
}

export function toProposalView(proposal: Proposal): ProposalView {
  const { approvalNonceHash: _omit, ...view } = proposal;
  return Object.freeze(view);
}

function requireStatus(proposal: Proposal, allowed: readonly ProposalStatus[]): void {
  if (!allowed.includes(proposal.status)) {
    throw new ProposalError('invalid_transition', `proposal ${proposal.proposalId} is ${proposal.status}`);
  }
}

function withStatus(proposal: Proposal, status: ProposalStatus, patch: { approvalNonceHash?: string | undefined } = {}): Proposal {
  const next: Record<string, unknown> = { ...proposal, status };
  if ('approvalNonceHash' in patch) {
    if (patch.approvalNonceHash === undefined) delete next.approvalNonceHash;
    else next.approvalNonceHash = patch.approvalNonceHash;
  }
  return Object.freeze(next) as unknown as Proposal;
}

function sameTarget(a: TargetBinding, b: TargetBinding): boolean {
  return a.connectionId === b.connectionId
    && a.dialect === b.dialect
    && (a.database ?? '') === (b.database ?? '')
    && (a.schema ?? '') === (b.schema ?? '');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
