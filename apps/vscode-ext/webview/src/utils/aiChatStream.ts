/**
 * AI Chat 消息渲染纯函数（P9 S3）。
 *
 * 轻量 Markdown：仅解析**围栏代码块**（```lang）与**行内 code**；
 * 其余文本按纯文本渲染（Vue 侧 white-space: pre-wrap，不 v-html —— 模型输出
 * 属于不可信内容，禁止注入 HTML）。流式未闭合的围栏按代码块渲染（进行中）。
 */

export type AiMessageBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string; content: string };

export type AiInlineSegment = { type: 'text' | 'code'; content: string };

/** 解析消息为块序列（围栏代码块 + 文本块）。未闭合围栏按代码块处理。 */
export function parseMessageBlocks(text: string): AiMessageBlock[] {
  const blocks: AiMessageBlock[] = [];
  const lines = text.split('\n');
  let textLines: string[] = [];
  let codeLines: string[] | null = null;
  let lang = '';

  const flushText = (): void => {
    const content = trimBlankEdges(textLines).join('\n');
    textLines = [];
    if (content) blocks.push({ type: 'text', content });
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
  return blocks;
}

/** 文本块的行内 `code` 切分（不解析加粗/斜体等；S4 再扩展完整 Markdown）。 */
export function parseInlineSegments(text: string): AiInlineSegment[] {
  const segments: AiInlineSegment[] = [];
  const regex = /`([^`\n]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    if (match.index > lastIndex) segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    segments.push({ type: 'code', content: match[1] });
    lastIndex = match.index + match[0].length;
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