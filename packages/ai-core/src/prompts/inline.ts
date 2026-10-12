import type { ChatMessage } from '../chat.js';
import { dialectLine, joinSections, section, withSystem } from './render.js';

export interface InlineCompletionInput {
  /** 光标前的 SQL（调用方裁剪窗口，≤4000 字符）。 */
  before: string;
  /** 光标后的 SQL（可选，≤500 字符；用于续写语义）。 */
  after?: string;
  /** 轻量 schema（引用表 + 外键邻接，≤1.5K tokens）。 */
  schemaText?: string;
  dbType?: string;
}

/** 空补全哨兵：模型无补全时输出它，调用方据此不下发 ghost 建议。 */
export const INLINE_NONE = '<none>';

/**
 * Inline 补全 prompt 契约（P9 S5，§6.11.5）：
 * - 光标位置 = "SQL before cursor" 段的末尾；
 * - 输出契约：只输出**光标处应插入的精确文本**（无 markdown/围栏/引号/解释）；
 *   无需补全输出哨兵 `<none>`；
 * - 温度 0 / max_tokens 小由调用方设置，本 builder 只管内容。
 */
export function buildInlineCompletionMessages(input: InlineCompletionInput): ChatMessage[] {
  return withSystem(
    joinSections([
      'Task: complete the SQL the user is typing. The cursor is exactly at the END of the "SQL before cursor" text below.',
      section('Schema:', input.schemaText),
      dialectLine(input.dbType),
      section('SQL before cursor:', input.before),
      section('SQL after cursor:', input.after),
      `Output contract: reply with ONLY the exact text to insert at the cursor — no markdown fences, no explanations, ` +
        `no surrounding quotes. Keep it short (a few words or one clause). If nothing should be completed, reply with exactly: ${INLINE_NONE}`,
    ]),
  );
}