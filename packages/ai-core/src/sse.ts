export interface SseEvent {
  /** `data:` 行拼接后的载荷（多行以 `\n` 连接）。 */
  data: string;
}

/**
 * 极简 SSE 解析器（对齐 OpenAI `data: {...}\n\n` 格式）。
 *
 * - 输入为字节流；用 `TextDecoder(stream: true)` 处理跨 chunk 的多字节 UTF-8
 *   （代理对/汉字不会被字节边界切断）。
 * - 只关心 `data:` 字段；`:comment`、`event:`、`id:`、`retry:` 忽略。
 * - 空行作为事件分隔符；流结束时冲刷未闭合的最后一个事件。
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join('\n');
    dataLines = [];
    return { data };
  };

  const consumeLine = (rawLine: string): SseEvent | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    return undefined;
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const event = consumeLine(rawLine);
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const event = consumeLine(buffer);
    if (event) yield event;
  }
  const tail = flush();
  if (tail) yield tail;
}