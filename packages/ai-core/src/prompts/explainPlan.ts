import type { ChatMessage } from '../chat.js';
import { codeBlock, dialectLine, joinSections, optionalCodeBlock, section, withSystem } from './render.js';

export interface ExplainPlanStatementInput {
  sql: string;
  /** Normalized plan rendered as text (preferred). */
  planText?: string;
  /** Raw engine output when no structured plan could be parsed. */
  fallbackText?: string;
}

export interface ExplainPlanInput {
  statements: ExplainPlanStatementInput[];
  dbType?: string;
  /** Force the reply language; without it the model follows the English task text. */
  language?: 'zh' | 'en';
}

/**
 * "Explain this execution plan" prompt (P10 S4).
 *
 * The plan is already computed by the extension; the model only reads it and
 * advises. It never runs anything.
 */
export function buildExplainPlanMessages(input: ExplainPlanInput): ChatMessage[] {
  const multi = input.statements.length > 1;
  const blocks = input.statements.map((statement, index) =>
    joinSections([
      multi ? `Statement ${index + 1}:` : undefined,
      section('SQL:', codeBlock(statement.sql, 'sql')),
      section('Execution plan:', optionalCodeBlock(statement.planText)),
      section('Raw EXPLAIN output:', optionalCodeBlock(statement.fallbackText)),
    ]),
  );
  return withSystem(
    joinSections([
      'Task: explain the execution plan below in plain language. Say why the query may be slow, point out the most expensive or risky steps, and list concrete improvements in priority order (indexes, predicate/join rewrites).',
      input.language === 'zh' ? 'Reply in Simplified Chinese regardless of the language of these instructions.' : undefined,
      ...blocks,
      dialectLine(input.dbType),
      'Base every claim on the plan shown; if information is missing, say so instead of guessing. These are suggestions only — nothing will be executed. Wrap any proposed SQL in ```sql blocks.',
    ]),
  );
}