/**
 * AI Chat 消息渲染纯函数（P9 S3）。
 *
 * 轻量 Markdown：仅解析**围栏代码块**（```lang）与**行内 code**；
 * 其余文本按纯文本渲染（Vue 侧 white-space: pre-wrap，不 v-html —— 模型输出
 * 属于不可信内容，禁止注入 HTML）。流式未闭合的围栏按代码块渲染（进行中）。
 */

import type { ChartType } from './chartInference';

export type AiMessageBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string; content: string }
  | { type: 'table'; header: string[]; rows: string[][]; summary?: string }
  | { type: 'heading'; level: number; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'hr' };

export type AiInlineSegment =
  | { type: 'text' | 'code' | 'strong' | 'em'; content: string }
  | { type: 'link'; content: string; href: string };

/** 解析消息为块序列（围栏代码块 + 文本块）。未闭合围栏按代码块处理。 */
/** 自动执行的 SQL 块上限（P9.1 后续：防一条回复多查询刷屏/轰炸数据库）。 */
export const AUTO_SQL_BLOCK_LIMIT = 3;

/** 代码块的原始下标（MessageBubble v-for 的 index 口径）+ 内容。 */
export interface AiSqlBlockRef {
  blockIdx: number;
  content: string;
}

/**
 * 提取可自动执行的 SQL 代码块（口径与 CodeBlock.isSql 一致：lang 为 sql 或缺省），
 * 携带**原始块下标**用于结果内联回填。上限 AUTO_SQL_BLOCK_LIMIT；
 * 超出部分与写语句一样保留手动「Run in chat」按钮。
 */
export function autoExecutableSqlBlocks(text: string): AiSqlBlockRef[] {
  const refs: AiSqlBlockRef[] = [];
  parseMessageBlocks(text).forEach((b, i) => {
    if (b.type === 'code' && (!b.lang || b.lang === 'sql')) {
      const content = b.content.trim();
      if (content) refs.push({ blockIdx: i, content });
    }
  });
  return refs.slice(0, AUTO_SQL_BLOCK_LIMIT);
}

/**
 * 分片/完成消息是否属于其它会话：仅当两端 sessionId 都有值且不等才判外来
 * （新会话首发时 webview 尚无 activeSessionId，不得误丢合法分片）。
 */
export function isForeignSession(activeId: string | undefined, msgSessionId: unknown): boolean {
  return !!activeId && typeof msgSessionId === 'string' && msgSessionId !== '' && msgSessionId !== activeId;
}

/** toolResult 下行的展示载荷（host 透传 blockRef；字段与 AiDownMessage 一致）。 */
export interface AiToolResultPayload {
  title?: string;
  content?: string;
  lang?: string;
  format?: string;
  isError?: boolean;
  /** 用户消息命中图表意图（路径 A）→ 内联结果默认以图表呈现（可切回表格）。 */
  preferChart?: boolean;
  /** 用户明确指定的图型；null/缺省时按结果形态推荐。 */
  preferredChart?: ChartType | null;
  /** 实测执行耗时（ms；SQL in-chat）。 */
  costMs?: number;
  /** 用户取消或确认门禁未放行（无结果集）。 */
  canceled?: boolean;
}

/** 执行中指示载荷（toolRunning 下行；toolResult 到达即清除）。 */
export interface AiRunningPayload {
  runId: string;
  startedAt: number;
}

/**
 * toolResult → 气泡/内联共用的展示内容（标题 + md 正文或代码块）。
 * 与旧「尾部追加气泡」格式逐字一致（迁移抽纯函数）。
 */
export function formatToolResultContent(msg: AiToolResultPayload): { content: string; error: boolean } {
  const title = String(msg.title ?? '');
  const body = String(msg.content ?? '');
  const content =
    msg.format === 'markdown'
      ? body
        ? `${title}\n\n${body}`
        : title
      : `${title}\n\n\`\`\`${typeof msg.lang === 'string' ? msg.lang : ''}\n${body}\n\`\`\``;
  return { content, error: !!msg.isError };
}

export function parseMessageBlocks(text: string): AiMessageBlock[] {
  const blocks: AiMessageBlock[] = [];
  const lines = text.split('\n');
  let textLines: string[] = [];
  let codeLines: string[] | null = null;
  let lang = '';

  const flushText = (): void => {
    const content = trimBlankEdges(textLines).join('\n');
    textLines = [];
    if (content) blocks.push(...splitTables(content));
  };
  const flushCode = (): void => {
    if (codeLines && codeLines.length > 0) {
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
    }
    codeLines = null;
    lang = '';
  };

  for (const line of lines) {
    const fence = /^\s*```([\w#+-]*)\s*$/.exec(line);
    if (codeLines === null) {
      if (fence) {
        flushText();
        codeLines = [];
        lang = fence[1] ?? '';
      } else {
        textLines.push(line);
      }
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      flushCode();
      continue;
    }
    codeLines.push(line);
  }
  // 未闭合围栏（流式进行中/模型漏写结束围栏）：按代码块呈现，避免整段吞掉。
  if (codeLines !== null) flushCode();
  else flushText();
  return mergeTableSummaries(blocks);
}

/**
 * 单行文本块 + 紧邻表格块 → 合并为带 `summary` 的表格块（折叠头即该标题行）。
 * 多行文本不合并（可能是段落而非标题）；表格前的空行已由 trimBlankEdges 处理。
 */
function mergeTableSummaries(blocks: AiMessageBlock[]): AiMessageBlock[] {
  const out: AiMessageBlock[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (block.type === 'table' && prev && prev.type === 'text' && !prev.content.includes('\n')) {
      out.pop();
      out.push({ ...block, summary: prev.content });
      continue;
    }
    out.push(block);
  }
  return out;
}

/** 文本块的行内 `code` 切分（不解析加粗/斜体等；S4 再扩展完整 Markdown）。 */
export function parseInlineSegments(text: string): AiInlineSegment[] {
  const segments: AiInlineSegment[] = [];
  // 顺序很重要：先 code，再 bold，再 italic，最后 http/https 链接。
  const regex = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(?<!\w)_([^_\n]+)_(?!\w)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    if (match.index > lastIndex) segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    const token = match[0];
    if (match[1]) {
      segments.push({ type: 'code', content: token.slice(1, -1) });
    } else if (match[2]) {
      segments.push({ type: 'strong', content: token.slice(2, -2) });
    } else if (match[3]) {
      segments.push({ type: 'em', content: token.slice(1, -1) });
    } else if (match[4]) {
      const m = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (m) segments.push({ type: 'link', content: m[1]!, href: m[2]! });
      else segments.push({ type: 'text', content: token });
    } else {
      segments.push({ type: 'text', content: token });
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', content: text.slice(lastIndex) });
  return segments.length > 0 ? segments : [{ type: 'text', content: text }];
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

/**
 * 文本块内切出 Markdown 表格（管道行 + 分隔行 `---`；仅识别完整表格，
 * 流式未闭合的表格按纯文本渲染）。单元格 `\|` 还原为字面管道。
 */
function splitTables(content: string): AiMessageBlock[] {
  const lines = content.split('\n');
  const out: AiMessageBlock[] = [];
  let text: string[] = [];
  const flush = (): void => {
    const joined = trimBlankEdges(text).join('\n');
    text = [];
    if (joined) out.push(...parseTextBlocks(joined));
  };
  let i = 0;
  while (i < lines.length) {
    const table = parseTable(lines, i);
    if (table) {
      flush();
      out.push({ type: 'table', header: table.header, rows: table.rows });
      i = table.next;
      continue;
    }
    text.push(lines[i]);
    i += 1;
  }
  flush();
  return out;
}

/** 文本块 → 标题 / 列表 / 引用 / 分割线 / 段落（段落保留原始换行）。 */
function parseTextBlocks(content: string): AiMessageBlock[] {
  const lines = content.split('\n');
  const out: AiMessageBlock[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      out.push({ type: 'text', content: paragraph.join('\n') });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') { flush(); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      out.push({ type: 'heading', level: heading[1]!.length, content: heading[2]! });
      continue;
    }
    if (/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flush();
      out.push({ type: 'hr' });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const parts = [quote[1] ?? ''];
      while (i + 1 < lines.length) {
        const next = /^\s{0,3}>\s?(.*)$/.exec(lines[i + 1]!);
        if (!next) break;
        parts.push(next[1] ?? '');
        i += 1;
      }
      out.push({ type: 'quote', content: parts.join('\n') });
      continue;
    }
    const item = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush();
      const ordered = /^\d/.test(item[1]!);
      const items = [item[2]!];
      while (i + 1 < lines.length) {
        const next = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(lines[i + 1]!);
        if (!next || /^\d/.test(next[1]!) !== ordered) break;
        items.push(next[2]!);
        i += 1;
      }
      out.push({ type: 'list', ordered, items });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out;
}

function parseTable(lines: string[], start: number): { header: string[]; rows: string[][]; next: number } | null {
  const headerLine = lines[start];
  const separatorLine = lines[start + 1];
  if (headerLine === undefined || separatorLine === undefined) return null;
  if (!isPipeRow(headerLine) || !isSeparatorRow(separatorLine)) return null;
  const header = parseRow(headerLine);
  if (header.length === 0) return null;
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && isPipeRow(lines[i])) {
    const cells = parseRow(lines[i]);
    if (cells.length !== header.length) break;
    rows.push(cells);
    i += 1;
  }
  return { header, rows, next: i };
}

function isPipeRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

function isSeparatorRow(line: string): boolean {
  if (!isPipeRow(line)) return false;
  const cells = parseRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseRow(line: string): string[] {
  const body = line.trim().slice(1, -1);
  return body
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').replace(/\\\\/g, '\\').trim());
}