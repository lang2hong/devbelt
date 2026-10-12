import type { ChatMessage } from '../chat.js';
import { codeBlock, dialectLine, joinSections, optionalCodeBlock, section, withSystem } from './render.js';

export interface OptimizeSqlInput {
  sql: string;
  /** EXPLAIN 输出（可选；有则让建议基于真实执行计划）。 */
  explainText?: string;
  schemaText?: string;
  dbType?: string;
}

export function buildOptimizeMessages(input: OptimizeSqlInput): ChatMessage[] {
  return withSystem(
    joinSections([
      'Task: review the following SQL for correctness and performance, then propose concrete improvements (indexes to add, predicates/joins to rewrite, redundant work to remove).',
      section('SQL:', codeBlock(input.sql, 'sql')),
      section('EXPLAIN output:', optionalCodeBlock(input.explainText)),
      section('Schema:', input.schemaText),
      dialectLine(input.dbType),
      'Group suggestions by priority: high (index changes, join order), medium (predicate rewrites), low (style/aliases). Wrap any proposed SQL in ```sql blocks.',
    ]),
  );
}