import { describe, expect, it } from 'vitest';
import {
  ProposalError,
  approveProposal,
  authorizeExecution,
  completeProposal,
  computeSqlHash,
  createProposal,
  rejectProposal,
  revokeProposal,
  toProposalView,
} from '../src/index.js';
import type { CreateProposalInput, PolicyDecision, TargetBinding } from '../src/index.js';

const target: TargetBinding = { connectionId: 'c1', database: 'shop', schema: 'sales', dialect: 'PG' };
const SQL = 'UPDATE "sales"."orders" SET status = \'paid\' WHERE id = 1';
const allow: PolicyDecision = { allowed: true, requiresApproval: true };

const input = (over: Partial<CreateProposalInput> = {}): CreateProposalInput => ({
  target,
  normalizedSql: 'UPDATE orders SET status = ? WHERE id = ?',
  fullyQualifiedSql: SQL,
  riskClass: 'W2',
  estimatedRows: 1,
  dryRun: 'rolled_back',
  ...over,
});

const NOW = 1_000_000;
const create = (over: Partial<CreateProposalInput> = {}) => createProposal(input(over), { now: NOW, ttlMs: 60_000, proposalId: 'p1' });
const approved = () => approveProposal(create(), NOW + 1, 'nonce-1');

describe('createProposal', () => {
  it('binds the hash to target and SQL and freezes the result', () => {
    const p = create();
    expect(p.status).toBe('proposed');
    expect(p.sqlHash).toBe(computeSqlHash(target, SQL));
    expect(p.expiresAt).toBe(NOW + 60_000);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.target)).toBe(true);
  });

  it('changes the hash when any part of the target changes', () => {
    const base = computeSqlHash(target, SQL);
    expect(computeSqlHash({ ...target, schema: 'public' }, SQL)).not.toBe(base);
    expect(computeSqlHash({ ...target, database: 'other' }, SQL)).not.toBe(base);
    expect(computeSqlHash({ ...target, connectionId: 'c2' }, SQL)).not.toBe(base);
    expect(computeSqlHash({ ...target, dialect: 'MYSQL' }, SQL)).not.toBe(base);
    expect(computeSqlHash(target, `${SQL} `)).not.toBe(base);
  });

  it('rejects non-write classes and invalid input', () => {
    expect(() => create({ riskClass: 'R1' as never })).toThrow(ProposalError);
    expect(() => create({ fullyQualifiedSql: '  ' })).toThrow(/empty/);
    expect(() => create({ target: { ...target, connectionId: '' } })).toThrow(/connectionId/);
    expect(() => create({ estimatedRows: -1 })).toThrow(/estimatedRows/);
    expect(() => createProposal(input(), { now: NOW, ttlMs: 0 })).toThrow(/ttlMs/);
  });
});

describe('approve / reject / revoke', () => {
  it('returns the nonce to the host and stores only its hash', () => {
    const { proposal, nonce } = approved();
    expect(nonce).toBe('nonce-1');
    expect(proposal.status).toBe('approved');
    expect(proposal.approvalNonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(proposal)).not.toContain('nonce-1');
  });

  it('generates a random nonce by default', () => {
    const a = approveProposal(create(), NOW + 1).nonce;
    const b = approveProposal(create(), NOW + 1).nonce;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it('refuses to approve twice or after expiry', () => {
    const { proposal } = approved();
    expect(() => approveProposal(proposal, NOW + 2, 'x')).toThrow(/approved/);
    expect(() => approveProposal(create(), NOW + 60_000, 'x')).toThrow(/expired/);
  });

  it('allows reject only from proposed and revoke from proposed or approved', () => {
    expect(rejectProposal(create()).status).toBe('rejected');
    expect(() => rejectProposal(approved().proposal)).toThrow(ProposalError);
    expect(revokeProposal(approved().proposal).status).toBe('revoked');
    expect(() => revokeProposal(rejectProposal(create()))).toThrow(ProposalError);
  });

  it('strips the nonce hash from views', () => {
    const view = toProposalView(approved().proposal);
    expect('approvalNonceHash' in view).toBe(false);
  });
});

describe('authorizeExecution', () => {
  const req = (over: Partial<Parameters<typeof authorizeExecution>[1]> = {}) => ({
    nonce: 'nonce-1',
    target,
    fullyQualifiedSql: SQL,
    policy: allow,
    ...over,
  });

  it('authorizes the exact approved SQL and target once', () => {
    const { proposal } = approved();
    const result = authorizeExecution(proposal, req(), NOW + 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.status).toBe('executing');
    expect(result.proposal.approvalNonceHash).toBeUndefined();
    expect(authorizeExecution(result.proposal, req(), NOW + 3)).toEqual({ ok: false, reason: 'already_executed' });
  });

  it('rejects approve-A-execute-B, target switches and wrong nonces', () => {
    const { proposal } = approved();
    expect(authorizeExecution(proposal, req({ fullyQualifiedSql: 'DELETE FROM "sales"."orders"' }), NOW + 2))
      .toEqual({ ok: false, reason: 'sql_mismatch' });
    expect(authorizeExecution(proposal, req({ target: { ...target, schema: 'public' } }), NOW + 2))
      .toEqual({ ok: false, reason: 'target_mismatch' });
    expect(authorizeExecution(proposal, req({ nonce: 'nonce-2' }), NOW + 2))
      .toEqual({ ok: false, reason: 'nonce_mismatch' });
    expect(authorizeExecution(proposal, req({ nonce: '' }), NOW + 2))
      .toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it('rejects unapproved, expired and policy-denied executions', () => {
    expect(authorizeExecution(create(), req(), NOW + 2)).toEqual({ ok: false, reason: 'not_approved' });
    expect(authorizeExecution(approved().proposal, req(), NOW + 60_000)).toEqual({ ok: false, reason: 'expired' });
    expect(authorizeExecution(approved().proposal, req({ policy: { allowed: false, reason: 'production_denied' } }), NOW + 2))
      .toEqual({ ok: false, reason: 'policy_denied' });
    expect(authorizeExecution(revokeProposal(approved().proposal), req(), NOW + 2))
      .toEqual({ ok: false, reason: 'not_approved' });
  });

  it('completes only from executing', () => {
    const result = authorizeExecution(approved().proposal, req(), NOW + 2);
    if (!result.ok) throw new Error('expected ok');
    expect(completeProposal(result.proposal, 'succeeded').status).toBe('succeeded');
    expect(completeProposal(result.proposal, 'unknown').status).toBe('unknown');
    expect(() => completeProposal(approved().proposal, 'succeeded')).toThrow(ProposalError);
  });
});
