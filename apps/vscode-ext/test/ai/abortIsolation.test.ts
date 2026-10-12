import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AiAbortError } from '@devbelt/ai-core';
import { AiService } from '../../src/ai/aiService';
import type { AiKeyStore } from '../../src/ai/aiKeyStore';

/**
 * 每请求独立 AbortController 隔离（P9 S6，对齐 P8 N2 教训）：
 * 中止一条流不得连带中止另一条并发流。
 */

function keyStore(): AiKeyStore {
  return { getApiKey: async () => undefined, hasApiKey: async () => false } as unknown as AiKeyStore;
}

/** 第 1 条流：发一个 chunk 后悬挂（等待 abort）；第 2 条流：chunk + [DONE] 后正常结束。 */
function twoStreamFetch(): typeof fetch {
  let callIndex = 0;
  return (async (_input: unknown, init?: RequestInit) => {
    const index = callIndex++;
    const signal = init?.signal as AbortSignal;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"chunk-${index + 1}"}}]}\n\n`));
        if (index === 1) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
}

describe('AiService 并发流 abort 隔离', () => {
  it('abort A 后 B 继续正常完成（controller 不共享）', async () => {
    const service = new AiService({
      keyStore: keyStore(),
      auth: {
        isLoggedIn: () => true,
        getAccessToken: () => 'tok',
        getCachedEntitlement: () => undefined,
      },
      serverUrl: 'https://server.test',
      getConfig: () => ({
        provider: 'server-proxy',
        baseUrl: '',
        model: 'm',
        includeColumnComments: true,
        temperature: 0.2,
        schemaContextMode: 'current-db',
        dataSampleRows: 10,
      }),
      fetchImpl: twoStreamFetch(),
    });

    const streamA = service.streamChat({ model: 'm', messages: [] }, { feature: 'chat' });
    const iterA = streamA[Symbol.asyncIterator]();
    const firstA = await iterA.next();
    expect(firstA.value).toMatchObject({ delta: 'chunk-1' });

    const streamB = service.streamChat({ model: 'm', messages: [] }, { feature: 'chat' });
    // B 完整消费（fetch index=1 正常收尾）
    const chunksB: unknown[] = [];
    for await (const chunk of streamB) chunksB.push(chunk);
    expect(chunksB).toHaveLength(1);
    expect(chunksB[0]).toMatchObject({ delta: 'chunk-2' });

    // 现在中止 A：只影响 A（此时 fetch index=1 仍悬挂在 abort 监听上）
    streamA.abort();
    await expect(iterA.next()).rejects.toBeInstanceOf(AiAbortError);
  });
});