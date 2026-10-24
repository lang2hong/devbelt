import { DatabaseType } from '@devbelt/db-core';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import { parseExplain, type ExplainDialect, type ExplainParseResult } from '@devbelt/explain-core';
import { classifyWriteKind } from '../utils/sqlRisk';
import type { ExplainStatementView } from '../result/protocol';

export interface ExplainQuery {
  /** Structured request used for the plan tree. */
  sql: string;
  /** Legacy text request used when the structured format is unavailable. */
  fallbackSql: string;
}

export function dialectFor(dbType: DatabaseType): ExplainDialect | undefined {
  switch (dbType) {
    case DatabaseType.MYSQL:
      return 'mysql';
    case DatabaseType.PG:
      return 'postgres';
    case DatabaseType.SQLITE:
      return 'sqlite';
    default:
      return undefined;
  }
}

export function buildExplainQuery(dbType: DatabaseType, statement: string): ExplainQuery {
  switch (dbType) {
    case DatabaseType.MYSQL:
      return {
        sql: `EXPLAIN FORMAT=JSON ${statement}`,
        fallbackSql: `EXPLAIN ${statement}`,
      };
    case DatabaseType.PG:
      return {
        sql: `EXPLAIN (FORMAT JSON) ${statement}`,
        fallbackSql: `EXPLAIN ${statement}`,
      };
    case DatabaseType.SQLITE:
      // SQLite plain EXPLAIN returns VM bytecode; QUERY PLAN is the human plan.
      return {
        sql: `EXPLAIN QUERY PLAN ${statement}`,
        fallbackSql: `EXPLAIN QUERY PLAN ${statement}`,
      };
    default:
      throw new Error(`EXPLAIN is not supported for ${dbType}`);
  }
}

export function supportsAnalyze(dbType: DatabaseType): boolean {
  return dbType === DatabaseType.MYSQL || dbType === DatabaseType.PG;
}

/**
 * EXPLAIN ANALYZE really executes the statement; callers must gate and confirm.
 * PostgreSQL returns a JSON plan; MySQL 8 only returns TREE text.
 */
export function buildAnalyzeQuery(dbType: DatabaseType, statement: string): { sql: string } {
  if (dbType === DatabaseType.PG) return { sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}` };
  if (dbType === DatabaseType.MYSQL) return { sql: `EXPLAIN ANALYZE ${statement}` };
  throw new Error(`EXPLAIN ANALYZE is not supported for ${dbType}`);
}

export function shouldSkipExplain(statement: string, scanOptions?: SqlScanOptions): boolean {
  return classifyWriteKind(statement, scanOptions) === 'ddl';
}

/** Parse the rows returned by a structured EXPLAIN request. */
export function parseExplainRows(dialect: ExplainDialect, rows: unknown[]): ExplainParseResult {
  return parseExplain(dialect, rows);
}

/** Largest serialized statement payload sent to the webview (same budget as the ES panel). */
export const RAW_PAYLOAD_LIMIT_BYTES = 1024 * 1024;

/**
 * Rows as shown/copied in the raw pane. mysql2 returns the JSON plan as a
 * string in the `EXPLAIN` column; decode it so the copy is readable JSON
 * instead of an escaped string.
 */
export function rawForDisplay(dialect: ExplainDialect, rows: unknown[]): unknown[] {
  if (dialect !== 'mysql') return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const record = row as Record<string, unknown>;
    if (typeof record.EXPLAIN !== 'string') return row;
    try {
      return { ...record, EXPLAIN: JSON.parse(record.EXPLAIN) as unknown };
    } catch {
      return row;
    }
  });
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Keep a statement payload within `limitBytes`. The parsed tree is always
 * kept; the raw plan / fallback rows are dropped first, then fallback text is
 * clipped, and `rawTruncated` tells the UI that something was omitted.
 */
export function limitStatementPayload(
  view: ExplainStatementView,
  limitBytes = RAW_PAYLOAD_LIMIT_BYTES,
): ExplainStatementView {
  if (byteSize(view) <= limitBytes) return view;
  if (view.plan) {
    return { ...view, plan: { ...view.plan, raw: null }, rawTruncated: true };
  }
  if (view.fallback) {
    const text = Buffer.from(view.fallback.text, 'utf8').subarray(0, limitBytes).toString('utf8');
    return { ...view, fallback: { ...view.fallback, rows: [], text }, rawTruncated: true };
  }
  return view;
}

/** Render legacy EXPLAIN rows for the raw/fallback pane. */
export function rowsToText(rows: unknown[]): string {
  return rows
    .map((row) => {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        const values = Object.values(row as Record<string, unknown>);
        if (values.length === 1 && typeof values[0] === 'string') return values[0];
      }
      return typeof row === 'string' ? row : JSON.stringify(row);
    })
    .join('\n');
}