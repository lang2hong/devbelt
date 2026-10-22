import { DatabaseType } from '@devbelt/db-core';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import { parseExplain, type ExplainDialect, type ExplainParseResult } from '@devbelt/explain-core';
import { classifyWriteKind } from '../utils/sqlRisk';

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

export function shouldSkipExplain(statement: string, scanOptions?: SqlScanOptions): boolean {
  return classifyWriteKind(statement, scanOptions) === 'ddl';
}

/** Parse the rows returned by a structured EXPLAIN request. */
export function parseExplainRows(dialect: ExplainDialect, rows: unknown[]): ExplainParseResult {
  return parseExplain(dialect, rows);
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