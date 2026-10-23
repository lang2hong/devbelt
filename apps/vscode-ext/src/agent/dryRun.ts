import { classifyWriteKind } from '@devbelt/db-core/sql';
import type { DatabaseType } from '@devbelt/db-core';

export interface DryRunSession {
  query(sql: string, values?: unknown, options?: { skipHistory?: boolean; token?: { cancel?: () => void } }): Promise<{ affectedRows?: number }>;
}

export interface DryRunDeps {
  dbType: DatabaseType;
  /** A writable, isolated session. The caller closes it. */
  session: DryRunSession;
  /** Schema to look up triggers in (PG / MySQL); omit to skip the lookup. */
  schema?: string;
}

export type DryRunOutcome = 'rolled_back' | 'static_only' | 'failed';

export interface DryRunResult {
  outcome: DryRunOutcome;
  /** Rows the statement touched before the rollback. */
  affectedRows?: number;
  reason?: string;
}

/**
 * Restricted dry-run used before asking for write approval.
 *
 * DML on PG / MySQL runs inside a transaction and is rolled back. It is
 * skipped when the target table has triggers (side effects outside the
 * transaction cannot be undone) or when the table cannot be identified.
 * DDL is never executed; SQLite has no cross-call transaction, so neither.
 */
export async function dryRunStatement(sql: string, deps: DryRunDeps): Promise<DryRunResult> {
  if (classifyWriteKind(sql) !== 'dml') return { outcome: 'static_only', reason: 'not_dml' };
  if (deps.dbType === 'SQLITE') return { outcome: 'static_only', reason: 'sqlite_transaction' };

  const table = targetTable(sql);
  if (!table) return { outcome: 'static_only', reason: 'table_unknown' };
  if (await hasTriggers(deps, table)) return { outcome: 'static_only', reason: 'triggers' };

  const begin = deps.dbType === 'PG' ? 'BEGIN' : 'START TRANSACTION';
  try {
    await deps.session.query(begin, undefined, { skipHistory: true });
  } catch (err) {
    return { outcome: 'failed', reason: messageOf(err) };
  }
  try {
    const result = await deps.session.query(sql, undefined, { skipHistory: true });
    return { outcome: 'rolled_back', ...(typeof result.affectedRows === 'number' ? { affectedRows: result.affectedRows } : {}) };
  } catch (err) {
    return { outcome: 'failed', reason: messageOf(err) };
  } finally {
    await deps.session.query('ROLLBACK', undefined, { skipHistory: true }).catch(() => undefined);
  }
}

async function hasTriggers(deps: DryRunDeps, table: string): Promise<boolean> {
  try {
    const sql = deps.dbType === 'PG'
      ? 'SELECT count(*) AS n FROM information_schema.triggers WHERE event_object_table = $1'
      : 'SELECT count(*) AS n FROM information_schema.triggers WHERE event_object_table = ? AND event_object_schema = COALESCE(?, database())';
    const values = deps.dbType === 'PG' ? [table] : [table, deps.schema ?? null];
    const res = await deps.session.query(sql, values, { skipHistory: true }) as { rows?: Array<Record<string, unknown>> };
    const row = res.rows?.[0];
    const n = Number(row ? Object.values(row)[0] : 0);
    return Number.isFinite(n) && n > 0;
  } catch {
    // Cannot prove there are no triggers: fail safe and skip the dry run.
    return true;
  }
}

/** Best-effort target table for single-table DML; undefined means "do not dry run". */
export function targetTable(sql: string): string | undefined {
  // Do not use sqlSkeleton here: it blanks quoted identifiers, and the table name
  // may itself be quoted (`orders`). Leading comments are the only thing to skip.
  const code = sql.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '').trim();
  const m = /^(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+([^\s(]+)/i.exec(code);
  if (!m) return undefined;
  const token = m[1]!;
  if (token.includes(',')) return undefined;
  const rest = code.slice(m[0].length).trimStart();
  // Multi-table forms: UPDATE a JOIN b, DELETE FROM a USING b.
  if (/^(?:JOIN|USING)\b/i.test(rest)) return undefined;
  const parts = token.split('.')
    .map((p) => p.replace(/^[`"[]|[`"\]]$/g, ''))
    .filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !/^[\w$]+$/.test(p))) return undefined;
  return parts[parts.length - 1];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}