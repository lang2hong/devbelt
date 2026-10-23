import { DatabaseType } from '@devbelt/db-core';
import {
  extractPredicates,
  suggestIndexes,
  suggestedIndexName,
  type AdvisorTable,
  type ExplainPlan,
  type ExplainPlanNode,
} from '@devbelt/explain-core';
import type { SqlConnectionSession } from '../connection/connectionSession';
import type { IndexSuggestionView, RedundantIndexView } from '../result/protocol';

/** Upper bound on tables whose metadata is read for one statement. */
export const MAX_ADVISED_TABLES = 5;

/**
 * Tables the plan flags (full scan / filesort), lower-cased, in plan order.
 * Plan node names may be aliases (MySQL/SQLite); `aliases` maps them back.
 */
export function flaggedTables(plan: ExplainPlan, aliases: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly ExplainPlanNode[]): void => {
    for (const node of nodes) {
      if (node.object && (node.warnings.includes('fullTableScan') || node.warnings.includes('filesort'))) {
        const key = node.object.toLowerCase();
        const name = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
        if (!out.includes(name)) out.push(name);
      }
      walk(node.children);
    }
  };
  walk(plan.roots);
  return out;
}

export interface SuggestionContext {
  session: Pick<SqlConnectionSession, 'metadata'>;
  dbType: DatabaseType;
  database?: string;
  schema?: string;
}

/**
 * Build index suggestions for one parsed statement (P10 S6).
 *
 * Reads columns/indexes only for tables that both appear in the SQL and are
 * flagged by the plan (at most `MAX_ADVISED_TABLES`). A metadata failure for
 * one table skips that table; it never fails the plan. DDL text comes from the
 * dialect's own `createIndexSql` (identifier-validated) and is never executed.
 */
export async function buildIndexSuggestions(
  sql: string,
  plan: ExplainPlan,
  ctx: SuggestionContext,
): Promise<{ suggestions: IndexSuggestionView[]; redundant: RedundantIndexView[] }> {
  const extraction = extractPredicates(sql);
  const flagged = new Set(flaggedTables(plan, extraction.aliases));
  const targets = extraction.tables.filter((t) => flagged.has(t)).slice(0, MAX_ADVISED_TABLES);
  if (targets.length === 0) return { suggestions: [], redundant: [] };

  const tables: AdvisorTable[] = [];
  for (const name of targets) {
    try {
      const [columns, indexes] = await Promise.all([
        ctx.session.metadata.getColumns(name, ctx.database, ctx.schema),
        ctx.session.metadata.getIndexes(name, ctx.database, ctx.schema),
      ]);
      if (columns.length === 0) continue;
      tables.push({
        name,
        columns: columns.map((c) => ({
          name: c.name,
          type: c.type,
          isPrimary: c.isPrimary,
          isUnique: c.isUnique,
        })),
        indexes: indexes.map((i) => ({ name: i.name, columns: i.columns, isPrimary: i.isPrimary, isUnique: i.isUnique })),
      });
    } catch {
      // Missing table / no permission: skip this table, keep the rest.
    }
  }

  const advice = suggestIndexes({ plan, extraction, tables });
  const maxName = ctx.dbType === DatabaseType.PG ? 63 : 64;
  const suggestions: IndexSuggestionView[] = [];
  for (const s of advice.suggestions) {
    // Use the column names as declared (case matters on PG).
    const declared = tables.find((t) => t.name === s.table);
    const columns = s.columns.map((c) => declared?.columns.find((x) => x.name.toLowerCase() === c)?.name ?? c);
    const name = suggestedIndexName(s.table, columns, maxName);
    try {
      const ddl = ctx.session.metadata.createIndexSql(name, s.table, columns, false, ctx.database, ctx.schema);
      suggestions.push({ ...s, columns, name, sql: ddl });
    } catch {
      // Identifier rejected by validateIdent: do not offer unsafe DDL.
    }
  }
  return {
    suggestions,
    redundant: advice.redundant.map((r) => ({ table: r.table, index: r.index, coveredBy: r.coveredBy })),
  };
}