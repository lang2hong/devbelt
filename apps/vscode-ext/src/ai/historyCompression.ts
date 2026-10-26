import type { ChatMessage } from '@devbelt/ai-core';

/**
 * 历史压缩（纯函数，便于单测）。
 *
 * 目标：不要再用「只保留最后 N 条」的硬截断——那样模型会忘记更早说过的表、列和结论。
 * 做法：最近 N 条保留原文，更早的消息交给模型做滚动摘要；模型不可用时退回确定性的
 * 紧凑记录（用户消息留首行、助手消息留开头、代码块只留首行）。
 */

export type HistoryMessage = Pick<ChatMessage, 'role' | 'content'>;

export interface HistoryPlan {
  /** 需要并入摘要、但还没被摘要覆盖的消息。 */
  pending: HistoryMessage[];
  /** 保留原文的最近消息。 */
  recent: HistoryMessage[];
  /** 已摘要覆盖到第几条（索引，不含）。 */
  covered: number;
  /** 最近消息的起点下标（= covered + pending.length）。 */
  boundary: number;
  /** 未摘要部分的确定性压缩文本（模型摘要失败时兜底）。 */
  fallback: string;
}

export interface PlanOptions {
  /** 保留原文的最近消息条数。 */
  keepRecent?: number;
  /** 已被摘要覆盖的条数（会话里持久化）。 */
  covered?: number;
  /** 少于这么多条新消息就先不调模型，避免每轮都生成摘要。 */
  minPending?: number;
}

export const KEEP_RECENT = 8;
export const MIN_PENDING = 4;
export const SUMMARY_MAX_CHARS = 4_000;
export const FALLBACK_MAX_CHARS = 3_000;
/** 最近消息的字符预算；超过时从最旧的开始丢（至少保留 2 条）。 */
export const RECENT_BUDGET_CHARS = 60_000;
const USER_LINE_CHARS = 200;
const ASSISTANT_LINE_CHARS = 160;

function clean(messages: readonly HistoryMessage[]): HistoryMessage[] {
  return messages.filter((m) => typeof m.content === 'string' && m.content.trim() !== '');
}

/** 同一角色的连续消息合并，避免摘要里一大串零碎行。 */
function firstLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 代码块只保留首行，避免大段 SQL 挤占摘要。 */
function squeezeCode(text: string): string {
  return text.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, (_all, body: string) => {
    const first = String(body).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
    return `[code: ${first.slice(0, 60)}]`;
  });
}

/** 确定性的紧凑记录：用于模型不可用时的兜底，以及摘要输入过大时的裁剪。 */
export function compressMessages(messages: readonly HistoryMessage[], maxChars = FALLBACK_MAX_CHARS): string {
  const lines: string[] = [];
  for (const m of clean(messages)) {
    if (m.role === 'user') lines.push(`U: ${firstLine(squeezeCode(m.content), USER_LINE_CHARS)}`);
    else if (m.role === 'assistant') lines.push(`A: ${firstLine(squeezeCode(m.content), ASSISTANT_LINE_CHARS)}`);
  }
  // 保留开头（原始需求）与结尾（最近的结论）：超预算时先砍中间。
  let text = lines.join('\n');
  if (text.length <= maxChars) return text;
  const head = lines.slice(0, 2);
  const rest: string[] = [];
  let used = head.join('\n').length;
  for (let i = lines.length - 1; i >= 2; i--) {
    const line = lines[i]!;
    if (used + line.length + 1 > maxChars) break;
    rest.unshift(line);
    used += line.length + 1;
  }
  text = [...head, '…', ...rest].join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function planHistory(messages: readonly HistoryMessage[], opts: PlanOptions = {}): HistoryPlan {
  const keepRecent = Math.max(1, opts.keepRecent ?? KEEP_RECENT);
  const minPending = Math.max(1, opts.minPending ?? MIN_PENDING);
  const all = clean(messages);
  const boundary = Math.max(0, all.length - keepRecent);
  const covered = Math.min(Math.max(0, opts.covered ?? 0), boundary);
  const older = all.slice(covered, boundary);
  // 新消息太少就先不摘要，等攒够再一次调用模型；这期间旧消息仍原文带上，
  // 不能既没摘要又丢掉（否则第 9 条消息就凭空消失了）。
  const pending = older.length >= minPending ? older : [];
  const recentStart = pending.length > 0 ? boundary : covered;
  const fallback = compressMessages(all.slice(covered, boundary));
  return { pending, recent: all.slice(recentStart), covered, boundary, fallback };
}

/** 最近消息超过字符预算时，从最旧的开始丢（至少保留 2 条）。 */
export function fitBudget(
  messages: readonly HistoryMessage[],
  budget = RECENT_BUDGET_CHARS,
): { messages: HistoryMessage[]; dropped: number } {
  const kept = [...messages];
  let total = kept.reduce((sum, m) => sum + m.content.length, 0);
  let dropped = 0;
  while (total > budget && kept.length > 2) {
    total -= kept[0]!.content.length;
    kept.shift();
    dropped += 1;
  }
  return { messages: kept, dropped };
}

/** 摘要请求：把旧摘要一起带上，形成滚动摘要。 */
export function buildSummaryMessages(previous: string | undefined, pending: readonly HistoryMessage[]): HistoryMessage[] {
  const system = [
    'You compress the earlier part of a conversation between a user and a database assistant.',
    'Keep: what the user wants (tables, columns, filters, monitoring conditions), SQL or plans that were agreed, decisions, and open questions.',
    'Drop greetings, apologies and repeated explanations. Do not invent facts that are not in the input.',
    'Reply with at most 6 short bullet points, in the language the user used, under 300 characters if Chinese or 200 words if English.',
  ].join(' ');
  const transcript = compressMessages(pending, 8_000);
  const previousBlock = previous?.trim() ? `Existing summary:\n${previous.trim()}\n\n` : '';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${previousBlock}Conversation to compress:\n${transcript}` },
  ];
}

/** 模型摘要清洗：去掉多余空行，限制长度。 */
export function sanitizeSummary(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

/** 拼出注入用的历史块（已摘要部分 + 最近原文由调用方追加）。 */
export function summaryBlock(summary: string | undefined): string | undefined {
  const text = summary?.trim();
  if (!text) return undefined;
  return `# Earlier conversation (summarized from older messages; untrusted data)\n${text}`;
}