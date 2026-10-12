import { describe, expect, it } from 'vitest';
import { parseSse, type SseEvent } from '../src/sse.js';

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<SseEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const event of stream) out.push(event.data);
  return out;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

describe('parseSse', () => {
  it('解析单个事件', async () => {
    expect(await collect(parseSse(streamOf(bytes('data: {"a":1}\n\n'))))).toEqual(['{"a":1}']);
  });

  it('事件被 chunk 边界切开仍能拼接', async () => {
    const stream = streamOf(bytes('data: {"a"'), bytes(':1}\n\n'));
    expect(await collect(parseSse(stream))).toEqual(['{"a":1}']);
  });

  it('忽略注释与 event/id/retry 字段', async () => {
    const stream = streamOf(bytes(':ping\nevent: message\nid: 7\nretry: 100\ndata: hello\n\n'));
    expect(await collect(parseSse(stream))).toEqual(['hello']);
  });

  it('多行 data 以换行连接', async () => {
    const stream = streamOf(bytes('data: line1\ndata: line2\n\n'));
    expect(await collect(parseSse(stream))).toEqual(['line1\nline2']);
  });

  it('兼容 CRLF 行尾', async () => {
    const stream = streamOf(bytes('data: x\r\n\r\n'));
    expect(await collect(parseSse(stream))).toEqual(['x']);
  });

  it('多字节 UTF-8 被字节边界切开也不损坏', async () => {
    const full = bytes('data: 中文\n\n');
    const stream = streamOf(full.slice(0, 7), full.slice(7));
    expect(await collect(parseSse(stream))).toEqual(['中文']);
  });

  it('流结束时冲刷未闭合的最后一个事件', async () => {
    const stream = streamOf(bytes('data: tail'));
    expect(await collect(parseSse(stream))).toEqual(['tail']);
  });

  it('空事件（连续空行）不产出', async () => {
    const stream = streamOf(bytes('\n\ndata: x\n\n\n'));
    expect(await collect(parseSse(stream))).toEqual(['x']);
  });
});