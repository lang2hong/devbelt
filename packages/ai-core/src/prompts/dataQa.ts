import type { ChatMessage } from '../chat.js';
import { codeBlock, dialectLine, joinSections, section, withSystem } from './render.js';

export interface DataQaInput {
  /** 用户的自然语言提问。 */
  question: string;
  /** 产生结果集的 SQL。 */
  sql?: string;
  /** 列名列表（与样本列序一致）。 */
  columns?: string[];
  /** `formatRowSample` 输出的 JSON-lines（已打码/截断）；用户未确认时为 undefined。 */
  sampleText?: string;
  totalRows?: number;
  dbType?: string;
}

export function buildDataQaMessages(input: DataQaInput): ChatMessage[] {
  const totalLine =
    input.totalRows !== undefined ? `Total rows in result: ${input.totalRows} (only a sample is shown below).` : undefined;
  return withSystem(
    joinSections([
      'Task: answer the user question about the query result below. Be precise; base claims only on the shown sample and say when the sample is inconclusive.',
      section('Question:', input.question),
      section('SQL:', input.sql ? codeBlock(input.sql, 'sql') : undefined),
      input.columns?.length ? `Columns: ${input.columns.join(', ')}` : undefined,
      totalLine,
      section('Sample rows (JSON lines):', input.sampleText),
      dialectLine(input.dbType),
      'If a follow-up query would verify your answer, include it in a ```sql block.',
    ]),
  );
}