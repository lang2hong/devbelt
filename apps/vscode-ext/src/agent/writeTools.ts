import { classifyWriteKind } from '@devbelt/db-core/sql';
import type { DatabaseType } from '@devbelt/db-core';
import {
  ProposalError,
  approveProposal,
  authorizeExecution,
  completeProposal,
  createProposal,
  rejectProposal,
  type DryRunOutcome,
  type ExecutionLedger,
  type Proposal,
  type TargetBinding,
  type ToolDefinition,
  type WriteRiskClass,
} from '@devbelt/agent-core';
import { dryRunStatement, type DryRunResult, type DryRunSession } from './dryRun.js';
import { proposalEvent } from './ledger.js';
import type { ToolOutcome } from './runner.js';

export interface WritePreview {
  dryRun: DryRunResult;
  /** DDL can never be rolled back on MySQL; the modal must say so. */
  irreversible: boolean;
  production: boolean;
}

export interface WriteToolDeps {
  dbType: DatabaseType;
  target: TargetBinding;
  connection: { readOnly: boolean; production: boolean };
  settings: { allowWrites: boolean; allowDdl: boolean; allowProduction: boolean };
  /** Opens a writable isolated session; closed by the tool. */
  openSession(): Promise<{ session: DryRunSession; close: () => void }>;
  /** Native host confirmation. Must not be reachable from the webview or the model. */
  confirm(proposal: Proposal, preview: WritePreview): Promise<boolean>;
  ledger: ExecutionLedger;
  now?: () => number;
  ttlMs?: number;
}

export interface WriteTools {
  definitions: ToolDefinition[];
  handles(name: string): boolean;
  execute(name: string, sql: string, signal: AbortSignal): Promise<ToolOutcome>;
}

export const WRITE_TOOL_NAMES = ['propose_write', 'propose_ddl'] as const;

const definitions: ToolDefinition[] = [
  {
    name: 'propose_write',
    description: 'Propose one DML statement (INSERT/UPDATE/DELETE/REPLACE). The user must approve it before it runs.',
    riskClass: 'W2',
    engines: ['MYSQL', 'PG', 'SQLITE'],
    mcp: false,
    parameters: { type: 'object', properties: { sql: { type: 'string', maxLength: 10_000 } }, required: ['sql'], additionalProperties: false },
  },
  {
    name: 'propose_ddl',
    description: 'Propose one DDL statement (CREATE/ALTER/DROP/TRUNCATE/...). The user must approve it before it runs.',
    riskClass: 'W3',
    engines: ['MYSQL', 'PG', 'SQLITE'],
    mcp: false,
    parameters: { type: 'object', properties: { sql: { type: 'string', maxLength: 10_000 } }, required: ['sql'], additionalProperties: false },
  },
];

export function buildWriteTools(deps: WriteToolDeps): WriteTools {
  return {
    definitions: definitions.map((d) => ({ ...d })),
    handles: (name) => (WRITE_TOOL_NAMES as readonly string[]).includes(name),
    async execute(name, sql, signal) {
      const kind = name === 'propose_write' ? 'dml' : name === 'propose_ddl' ? 'ddl' : undefined;
      if (!kind) return refusal('unsupported_tool', 'Unsupported write tool.');
      if (!sql.trim()) return refusal('invalid_sql', 'sql is required.');

      const actual = classifyWriteKind(sql);
      if (kind === 'dml' && actual !== 'dml') return refusal('wrong_kind', 'propose_write only accepts DML statements.');
      if (kind === 'ddl' && actual !== 'ddl') return refusal('wrong_kind', 'propose_ddl only accepts DDL statements.');

      const policy = checkPolicy(deps, kind);
      if (policy) return refusal(policy, 'Write operations are not allowed on this connection.');

      const riskClass: WriteRiskClass = kind === 'dml' ? 'W2' : 'W3';
      let opened: Awaited<ReturnType<WriteToolDeps['openSession']>> | undefined;
      let dryRun: DryRunResult = { outcome: 'static_only', reason: 'not_started' };
      try {
        opened = await deps.openSession();
        if (kind === 'dml') {
          dryRun = await dryRunStatement(sql, {
            dbType: deps.dbType,
            session: opened.session,
            ...(deps.target.schema ? { schema: deps.target.schema } : {}),
          });
        }
        const proposal = createProposal({
          target: deps.target,
          normalizedSql: sql,
          fullyQualifiedSql: sql,
          riskClass,
          ...(dryRun.affectedRows !== undefined ? { estimatedRows: dryRun.affectedRows } : {}),
          dryRun: dryRunOutcome(dryRun),
        }, { now: (deps.now ?? Date.now)(), ttlMs: deps.ttlMs ?? 300_000 });

        if (!(await append(deps, proposal, 'PROPOSED', name))) {
          return refusal('ledger_failed', 'Could not write the approval record; the statement was not shown for approval.');
        }
        if (signal.aborted) return { content: 'Cancelled before approval.', isError: true, summary: '已取消' };

        const approved = await deps.confirm(proposal, {
          dryRun,
          irreversible: kind === 'ddl' || dryRun.outcome !== 'rolled_back',
          production: deps.connection.production,
        });
        if (!approved) {
          await append(deps, rejectProposal(proposal), 'REJECTED', name);
          return { content: 'User rejected the operation.', isError: true, errorCode: 'rejected', summary: '用户拒绝' };
        }

        const approval = approveProposal(proposal, (deps.now ?? Date.now)());
        if (!(await append(deps, approval.proposal, 'APPROVED', name))) {
          return refusal('ledger_failed', 'Could not write the approval record; the statement was not executed.');
        }
        const authorized = authorizeExecution(approval.proposal, {
          nonce: approval.nonce,
          target: deps.target,
          fullyQualifiedSql: sql,
          policy: { allowed: true, requiresApproval: true },
        }, (deps.now ?? Date.now)());
        if (!authorized.ok) {
          return refusal(authorized.reason, 'The approval no longer matches the statement or target.');
        }
        if (!(await append(deps, authorized.proposal, 'EXECUTING', name))) {
          return refusal('ledger_failed', 'Could not record EXECUTING; the statement was not executed.');
        }

        const started = Date.now();
        const token: { cancel?: () => void } = {};
        const onAbort = (): void => token.cancel?.();
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          if (signal.aborted) {
            const aborted = completeProposal(authorized.proposal, 'unknown');
            await append(deps, aborted, 'UNKNOWN', name, { errorCode: 'aborted' });
            return { content: 'Cancelled before execution.', isError: true, errorCode: 'aborted', summary: '已取消' };
          }
          const result = await opened.session.query(sql, undefined, { token });
          const affected = typeof result.affectedRows === 'number' ? result.affectedRows : undefined;
          const done = completeProposal(authorized.proposal, 'succeeded');
          await append(deps, done, 'SUCCEEDED', name, { affectedRows: affected, durationMs: Date.now() - started });
          return {
            content: JSON.stringify({ status: 'succeeded', ...(affected !== undefined ? { affectedRows: affected } : {}) }),
            summary: affected !== undefined ? `已执行，影响 ${affected} 行` : '已执行',
          };
        } catch (err) {
          const failed = completeProposal(authorized.proposal, 'failed');
          await append(deps, failed, 'FAILED', name, { durationMs: Date.now() - started, errorCode: 'execution_failed' });
          return { content: `Execution failed: ${messageOf(err)}`, isError: true, errorCode: 'execution_failed', summary: '执行失败' };
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      } catch (err) {
        if (err instanceof ProposalError) return refusal(err.code, err.message);
        return { content: `Write tool failed: ${messageOf(err)}`, isError: true, errorCode: 'tool_failed', summary: '工具失败' };
      } finally {
        opened?.close();
      }
    },
  };
}

function checkPolicy(deps: WriteToolDeps, kind: 'dml' | 'ddl'): string | undefined {
  if (deps.connection.readOnly) return 'read_only_connection';
  if (kind === 'dml' && !deps.settings.allowWrites) return 'writes_disabled';
  if (kind === 'ddl' && !deps.settings.allowDdl) return 'ddl_disabled';
  if (deps.connection.production && !deps.settings.allowProduction) return 'production_denied';
  return undefined;
}

function dryRunOutcome(result: DryRunResult): DryRunOutcome {
  if (result.outcome === 'rolled_back') return 'rolled_back';
  if (result.outcome === 'failed') return 'failed';
  return 'static_only';
}

async function append(
  deps: WriteToolDeps,
  proposal: Proposal,
  state: 'PROPOSED' | 'REJECTED' | 'APPROVED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN',
  tool: string,
  extra: { affectedRows?: number; durationMs?: number; errorCode?: string } = {},
): Promise<boolean> {
  try {
    await deps.ledger.append(proposalEvent(proposal, state, { tool, ...extra }));
    return true;
  } catch {
    return false;
  }
}

function refusal(code: string, message: string): ToolOutcome {
  return { content: message, isError: true, errorCode: code, summary: `被拒绝：${code}` };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}