import { parseMysqlExplain } from './mysql.js';
import { parsePostgresExplain } from './postgres.js';
import { parseSqliteExplain } from './sqlite.js';
import type { ExplainDialect, ExplainParseOptions, ExplainParseResult } from './types.js';

export * from './types.js';
export { parseMysqlExplain } from './mysql.js';
export { parsePostgresExplain } from './postgres.js';
export { parseSqliteExplain } from './sqlite.js';
export {
  formatPlanText,
  DEFAULT_FORMAT_MAX_CHARS,
  DEFAULT_FORMAT_MAX_NODES,
  type FormatPlanOptions,
} from './format.js';
export {
  extractPredicates,
  type ColumnPredicate,
  type PredicateExtraction,
  type PredicateKind,
} from './predicates.js';
export {
  suggestIndexes,
  suggestedIndexName,
  type AdvisorColumn,
  type AdvisorIndex,
  type AdvisorTable,
  type IndexAdvice,
  type IndexAdvisorInput,
  type IndexSuggestion,
  type RedundantIndex,
  type SuggestionConfidence,
  type SuggestionReason,
  type SuggestionRisk,
} from './indexAdvisor.js';

/** Parse an EXPLAIN result using the dialect that produced it. */
export function parseExplain(
  dialect: ExplainDialect,
  raw: unknown,
  options: ExplainParseOptions = {},
): ExplainParseResult {
  switch (dialect) {
    case 'mysql':
      return parseMysqlExplain(raw, options);
    case 'postgres':
      return parsePostgresExplain(raw, options);
    case 'sqlite':
      return parseSqliteExplain(raw, options);
  }
}