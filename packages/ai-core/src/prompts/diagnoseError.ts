import type { ChatMessage } from '../chat.js';
import { codeBlock, dialectLine, joinSections, section, withSystem } from './render.js';

export interface DiagnoseErrorInput {
  /** 错误信息原文（调用方须先做敏感信息扫描；命中时默认阻断发送）。 */
  error: string;
  /** 触发错误的 SQL（已脱敏）。 */
  sql?: string;
  dbType?: string;
}

export function buildDiagnoseMessages(input: DiagnoseErrorInput): ChatMessage[] {
  return withSystem(
    joinSections([
      'Task: diagnose the database error below. Explain it in plain language, list 1-3 likely causes, suggest a fix, and classify it as one of: user-input mistake, permission issue, data issue, schema/index issue.',
      section('Error:', input.error),
      section('SQL:', input.sql ? codeBlock(input.sql, 'sql') : undefined),
      dialectLine(input.dbType),
      'If the provided context is not enough to be sure, say which additional information is needed.',
    ]),
  );
}