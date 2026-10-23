import { JsonlExecutionLedger, type ExecutionLedger, type LedgerEventInput, type LedgerState, type Proposal } from '@devbelt/agent-core';

/** Ledger shared by agent write approvals; stored outside the workspace. */
export function agentLedgerPath(storageRoot: string): string {
  return `${storageRoot.replace(/[\\/]+$/, '')}/agent/ledger.jsonl`;
}

export function createAgentLedger(path: string): JsonlExecutionLedger {
  return new JsonlExecutionLedger({ path });
}

/** Mark leftover EXECUTING events as UNKNOWN. Returns how many were recovered. */
export async function recoverAgentLedger(path: string): Promise<number> {
  const ledger = createAgentLedger(path);
  const recovered = await ledger.recoverInterrupted();
  return recovered.length;
}

/** Build a ledger event from a proposal plus the state being recorded. */
export function proposalEvent(
  proposal: Proposal,
  state: LedgerState,
  extra: { tool: string; affectedRows?: number; durationMs?: number; errorCode?: string } = { tool: '' },
): LedgerEventInput {
  return {
    proposalId: proposal.proposalId,
    state,
    surface: 'agent',
    riskClass: proposal.riskClass,
    target: proposal.target,
    sqlHash: proposal.sqlHash,
    estimatedRows: proposal.estimatedRows,
    ...(extra.tool ? { tool: extra.tool } : {}),
    ...(extra.affectedRows !== undefined ? { affectedRows: extra.affectedRows } : {}),
    ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
  };
}

export type { ExecutionLedger };