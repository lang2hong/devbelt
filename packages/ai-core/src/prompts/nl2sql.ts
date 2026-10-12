import type { ChatMessage } from '../chat.js';
import { dialectLine, joinSections, section, withSystem } from './render.js';

export interface Nl2SqlInput {
  /** 用户的自然语言请求。 */
  request: string;
  /** `serializeSchema` 输出。 */
  schemaText?: string;
  dbType?: string;
}

export function buildNl2SqlMessages(input: Nl2SqlInput): ChatMessage[] {
  return withSystem(
    joinSections([
      'Task: translate the user request into SQL for the connected database. Use exactly one statement when possible.',
      section('Schema:', input.schemaText),
      dialectLine(input.dbType),
      section('Request:', input.request),
      'Return the SQL in a ```sql code block, then briefly explain what it does. If the schema is missing something needed, say so instead of guessing.',
    ]),
  );
}