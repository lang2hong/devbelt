import type { ChatMessage } from '../chat.js';
import { codeBlock, dialectLine, joinSections, section, withSystem } from './render.js';

export interface ExplainSqlInput {
  sql: string;
  schemaText?: string;
  dbType?: string;
}

export function buildExplainMessages(input: ExplainSqlInput): ChatMessage[] {
  return withSystem(
    joinSections([
      'Task: explain what the following SQL statement does, in plain language. Cover the tables/joins involved and walk through each clause.',
      section('SQL:', codeBlock(input.sql, 'sql')),
      section('Schema:', input.schemaText),
      dialectLine(input.dbType),
      'Keep the explanation concise and structured. Do not suggest changes unless something is clearly wrong.',
    ]),
  );
}