/**
 * NL→ES DSL 输出解析（P9 S7c）。
 *
 * 契约（ES_DSL_SYSTEM_PROMPT 要求）：
 *   1. `**意图理解：**<一句话>`；
 *   2. 一个 \u0060\u0060\u0060json 代码块 = `POST /<index>/_search` 请求体；
 *   3. 可选 Assumptions 区。
 *
 * 宽松提取（与 parseSqlAnswer 同策略）：无块/非法 JSON 不抛错，由执行层报可读错误。
 */
import { extractAssumptions, extractParaphrase } from './nl2sqlOutput.js';

export interface ParsedEsDslAnswer {
  /** 原始（trim 后）JSON 文本；无块为空串。 */
  bodyText: string;
  /** JSON.parse 成功且为普通对象时的请求体；否则 undefined。 */
  body?: Record<string, unknown>;
  /** 解析失败的机器可读原因（invalid-json / not-an-object）。 */
  parseError?: 'invalid-json' | 'not-an-object';
  intentParaphrase: string;
  assumptions: string[];
}

export function parseEsDslAnswer(text: string): ParsedEsDslAnswer {
  const bodyText = extractJsonBlock(text);
  const parsed: ParsedEsDslAnswer = {
    bodyText,
    intentParaphrase: extractParaphrase(text),
    assumptions: extractAssumptions(text),
  };
  if (!bodyText) return parsed;
  try {
    const value: unknown = JSON.parse(bodyText);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      parsed.parseError = 'not-an-object';
      return parsed;
    }
    parsed.body = value as Record<string, unknown>;
  } catch {
    parsed.parseError = 'invalid-json';
  }
  return parsed;
}

/** 代码块提取：优先 \u0060\u0060\u0060json，否则首个无标注块；无块为空串。 */
export function extractJsonBlock(text: string): string {
  const blocks: Array<{ lang: string; content: string }> = [];
  const regex = /```([\w#+-]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    blocks.push({ lang: (match[1] ?? '').toLowerCase(), content: match[2] });
  }
  const block = blocks.find((b) => b.lang === 'json') ?? blocks.find((b) => b.lang === '');
  return block ? block.content.trim() : '';
}
