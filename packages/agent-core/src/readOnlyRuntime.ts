import type { QueryCancelToken, QueryOptions, QueryResult } from '@devbelt/db-core';
import { checkReadOnlySql } from './readOnlySql.js';
import type { ReadOnlySqlRejectReason } from './readOnlySql.js';
import { sanitizeQueryResult, sanitizeToolError } from './sanitizer.js';
import type { QueryBudget, QueryResultView, SanitizeQueryOptions, ToolResultEnvelope } from './sanitizer.js';
import type { AgentEngine } from './types.js';

/** The slice of db-core `QueryService` the runtime needs. */
export interface ReadOnlyQuerySession {
  query(sql: string, values?: unknown, options?: QueryOptions): Promise<QueryResult>;
}

export interface ReadOnlySessionTarget {
  engine: AgentEngine;
  session: ReadOnlyQuerySession;
  /**
   * SQLite cannot hold a transaction across driver calls, so the session itself
   * must have been opened read-only (`.open --readonly` + `PRAGMA query_only`).
   */
  sessionReadOnly: boolean;
}

export interface RunReadOnlyOptions {
  tool?: string;
  /** Rows fetched from the database; one extra row detects truncation. */
  maxRows?: number;
  /** Server-side statement timeout where supported. */
  timeoutMs?: number;
  token?: QueryCancelToken;
  sanitize?: SanitizeQueryOptions;
  budget?: Partial<QueryBudget>;
}

export type RuntimeRejectReason =
  | ReadOnlySqlRejectReason
  | 'session_not_read_only'
  | 'not_explain';

export type ReadOnlyRunResult =
  | { ok: true; envelope: ToolResultEnvelope<QueryResultView>; truncated: boolean }
  | { ok: false; reason: RuntimeRejectReason; detail?: string }
  | { ok: false; reason: 'query_failed'; envelope: ToolResultEnvelope<{ error: string }> };

const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run one model- or MCP-supplied read-only statement.
 *
 * 1. `checkReadOnlySql` (single statement, read shape, keyword/function denylists);
 * 2. execute inside a database-level read-only scope:
 *    - PG: `BEGIN READ ONLY` → `SET LOCAL statement_timeout` → statement → `ROLLBACK`
 *    - MySQL: `START TRANSACTION READ ONLY` → statement → `ROLLBACK`
 *    - SQLite: only on a session opened read-only;
 * 3. always roll back, also on error or cancel;
 * 4. return a sanitised envelope.
 *
 * Calls on one session are serialised by the caller (one agent session = one
 * isolated SQL session); this function does not share transactions across calls.
 */
export async function runReadOnlyQuery(
  target: ReadOnlySessionTarget,
  sql: string,
  options: RunReadOnlyOptions = {},
): Promise<ReadOnlyRunResult> {
  const tool = options.tool ?? 'run_read_only_query';
  const check = checkReadOnlySql(sql, target.engine);
  if (!check.ok) return { ok: false, reason: check.reason, ...(check.detail ? { detail: check.detail } : {}) };
  if (target.engine === 'SQLITE' && !target.sessionReadOnly) return { ok: false, reason: 'session_not_read_only' };

  const maxRows = clampInt(options.maxRows ?? DEFAULT_MAX_ROWS, 1, 10_000);
  const statement = check.kind === 'select' ? limitWrap(check.statement, maxRows + 1) : check.statement;

  try {
    const result = await inReadOnlyScope(target, options, (q) => q(statement));
    const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
    const columns = (result.fields ?? []).map((f) => f.name);
    const truncated = check.kind === 'select' && rows.length > maxRows;
    const kept = truncated ? rows.slice(0, maxRows) : rows;
    const envelope = sanitizeQueryResult(tool, columns.length > 0 ? columns : Object.keys(kept[0] ?? {}), kept, options.sanitize, options.budget);
    if (truncated) {
      envelope.truncated = true;
      envelope.notes.push(`result limited to ${maxRows} rows`);
    }
    return { ok: true, envelope, truncated };
  } catch (err) {
    return { ok: false, reason: 'query_failed', envelope: sanitizeToolError(tool, errorMessage(err)) };
  }
}

/** Plain EXPLAIN only; returns the raw plan rows for the caller to normalise. */
export async function explainReadOnly(
  target: ReadOnlySessionTarget,
  sql: string,
  options: Omit<RunReadOnlyOptions, 'maxRows' | 'sanitize' | 'budget'> = {},
): Promise<{ ok: true; rows: unknown[] } | { ok: false; reason: RuntimeRejectReason | 'query_failed'; detail?: string }> {
  const check = checkReadOnlySql(sql, target.engine);
  if (!check.ok) return { ok: false, reason: check.reason, ...(check.detail ? { detail: check.detail } : {}) };
  if (check.kind !== 'explain') return { ok: false, reason: 'not_explain' };
  if (target.engine === 'SQLITE' && !target.sessionReadOnly) return { ok: false, reason: 'session_not_read_only' };
  try {
    const result = await inReadOnlyScope(target, options, (q) => q(check.statement));
    return { ok: true, rows: Array.isArray(result.rows) ? result.rows : [] };
  } catch (err) {
    return { ok: false, reason: 'query_failed', detail: sanitizeToolError(options.tool ?? 'explain_query', errorMessage(err)).data.error };
  }
}

type Run = (sql: string) => Promise<QueryResult>;

async function inReadOnlyScope(
  target: ReadOnlySessionTarget,
  options: { timeoutMs?: number; token?: QueryCancelToken },
  body: (run: Run) => Promise<QueryResult>,
): Promise<QueryResult> {
  const { session, engine } = target;
  const control = (sql: string) => session.query(sql, undefined, { skipHistory: true });
  const run: Run = (sql) => session.query(sql, undefined, { skipHistory: true, ...(options.token ? { token: options.token } : {}) });

  if (engine === 'SQLITE') return body(run);

  const timeoutMs = clampInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 600_000);
  if (engine === 'PG') {
    await control('BEGIN READ ONLY');
  } else {
    // MySQL: max_execution_time applies to SELECT only; the client-side timeout
    // (QueryService + KILL QUERY) covers the rest.
    await control(`SET SESSION max_execution_time = ${timeoutMs}`);
    await control('START TRANSACTION READ ONLY');
  }
  try {
    if (engine === 'PG') await control(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return await body(run);
  } finally {
    // Always end the scope; a failed ROLLBACK must not hide the original error.
    await control('ROLLBACK').catch(() => undefined);
  }
}

/** Wrap a SELECT/WITH/VALUES statement so the database returns at most `limit` rows. */
function limitWrap(statement: string, limit: number): string {
  const body = statement.replace(/;\s*$/, '');
  return `SELECT * FROM (${body}) AS devbelt_q LIMIT ${limit}`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
