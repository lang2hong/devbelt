/**
 * NL→Redis 输出解析（P9 S7b）。
 *
 * 契约（REDIS_SYSTEM_PROMPT 要求）：
 *   1. `**意图理解：**<一句话>`；
 *   2. 一个 \u0060\u0060\u0060redis 代码块（一行一命令）；
 *   3. 可选 Assumptions 区。
 *
 * 宽松提取（与 parseSqlAnswer 同策略）：找不到给空、解析不抛错；
 * 代码块内过滤空行/注释行，以及 SELECT（连接级换库由客户端统一管理，CLI 同规则禁止）。
 */
import { extractAssumptions, extractParaphrase } from './nl2sqlOutput.js';

export interface ParsedRedisAnswer {
  /** 干净命令行（去掉空行/注释/SELECT；保留引号语义原文）。 */
  commands: string[];
  /** 原始代码块内容（未过滤，供展示/审计）。 */
  block: string;
  /** 一句话意图复述；缺失为空串。 */
  intentParaphrase: string;
  /** Assumptions 列表（≤3 条）。 */
  assumptions: string[];
}

export function parseRedisAnswer(text: string): ParsedRedisAnswer {
  const block = extractRedisBlock(text);
  return {
    commands: commandLines(block),
    block,
    intentParaphrase: extractParaphrase(text),
    assumptions: extractAssumptions(text),
  };
}

/** 提取命令行（过滤空行、# / // 注释、SELECT）。 */
export function commandLines(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'))
    .filter((line) => !/^select(\s|$)/i.test(line));
}

/** 代码块提取：优先 \u0060\u0060\u0060redis，否则第一个无标注块；无块为空串。 */
export function extractRedisBlock(text: string): string {
  const blocks: Array<{ lang: string; content: string }> = [];
  const regex = /```([\w#+-]*)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    blocks.push({ lang: (match[1] ?? '').toLowerCase(), content: match[2] });
  }
  const block = blocks.find((b) => b.lang === 'redis') ?? blocks.find((b) => b.lang === '');
  return block ? block.content.trim() : '';
}
