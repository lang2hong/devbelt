import type { ChatMessage } from '../chat.js';
import { dialectLine, joinSections, section, withSystem } from './render.js';

export interface SchemaDesignInput {
  /**
   * generate：自然语言 → 列/索引建议；review：审阅现有表结构 → 改进建议。
   */
  mode: 'generate' | 'review';
  /** generate 模式：用户对表的自然语言描述。 */
  request?: string;
  /** review 模式：现有表名（用于指代）。 */
  tableName?: string;
  /** review 模式：当前表结构（`serializeSchema` 输出的单表部分或等价文本）。 */
  schemaText?: string;
  dbType?: string;
}

export function buildSchemaDesignMessages(input: SchemaDesignInput): ChatMessage[] {
  const task =
    input.mode === 'generate'
      ? 'Task: propose a table design (columns with types, NOT NULL/defaults, primary key, indexes, foreign keys) for the described table. Follow the naming and typing conventions of the provided schema if any.'
      : 'Task: review the current table structure below and propose improvements (normalization, missing indexes, column types, constraints, naming). Group suggestions by priority.';
  return withSystem(
    joinSections([
      task,
      section('Request:', input.request),
      input.tableName ? `Table: ${input.tableName}` : undefined,
      section('Current structure:', input.schemaText),
      dialectLine(input.dbType),
      'Wrap any proposed DDL in a ```sql code block. Explain the reasoning for each suggestion briefly. Do not drop or rewrite existing structures unless clearly justified.',
    ]),
  );
}