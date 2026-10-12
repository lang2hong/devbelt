import { describe, expect, it, vi } from 'vitest';
import {
  AiAbortError,
  AiAuthError,
  AiNetworkError,
  AiQuotaExceededError,
  AiRateLimitedError,
} from '@devbelt/ai-core';
import { ServerProxyProvider } from '../../src/ai/serverProxyProvider';
import { AiLoginRequiredError } from '../../src/ai/aiErrors';

async function first<T>(iterable: AsyncIterable<T>): Promise<T> {
  for await (const item of iterable) return item;
  throw new Error('empty stream');
}

function sseText(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join('');
}

function recordingFetch(response: Response | (() => Promise<Response> | Response)): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof response === 'function' ? await response() : response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function provider(
  fetchImpl: typeof fetch,
  token: string | null = 'tok-1',
  onAuthFailure?: () => Promise<string | undefined>,
) {
  return new ServerProxyProvider({
    serverUrl: 'https://server.test/',
    getAccessToken: () => token ?? undefined,
    ...(onAuthFailure ? { onAuthFailure } : {}),
    fetchImpl,
  });
}

describe('ServerProxyProvider', () => {
  it('未登录（无 access token）→ AiLoginRequiredError', async () => {
    const { fetchImpl } = recordingFetch(new Response(''));
    const iterate = async () => {
      for await (const _c of provider(fetchImpl, null).chatStream({ model: 'm', messages: [] })) void _c;
    };
    await expect(iterate()).rejects.toBeInstanceOf(AiLoginRequiredError);
  });

  it('流式：URL/认证头/请求体正确，delta/finish/usage 解析', async () => {
    const events = [
      '{"choices":[{"delta":{"content":"你"}}]}',
      '{"choices":[{"delta":{"content":"好"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
      '[DONE]',
    ];
    const { calls, fetchImpl } = recordingFetch(new Response(sseText(events), { status: 200 }));
    const chunks = [];
    for await (const chunk of provider(fetchImpl).chatStream({
      model: 'm1',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      maxTokens: 128,
      feature: 'chat',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: '你', finishReason: undefined, usage: undefined },
      { delta: '好', finishReason: undefined, usage: undefined },
      { delta: undefined, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
    ]);
    expect(calls[0].url).toBe('https://server.test/api/ai/chat');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: 'm1',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.3,
      maxTokens: 128,
      feature: 'chat',
    });
    expect(payload.stream).toBeUndefined();
  });

  it('409 → AiQuotaExceededError 且携带 limit/used/reserved/resetAt', async () => {
    const body = JSON.stringify({
      message: 'AI monthly token quota exceeded',
      code: 'AI_QUOTA_EXCEEDED',
      limit: 100000,
      used: 100000,
      reserved: 0,
      resetAt: '2026-11-01T00:00:00.000Z',
    });
    const { fetchImpl } = recordingFetch(new Response(body, { status: 409 }));
    const err = await first(provider(fetchImpl).chatStream({ model: 'm', messages: [] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiQuotaExceededError);
    expect((err as AiQuotaExceededError).quota).toMatchObject({
      limit: 100000,
      used: 100000,
      reserved: 0,
      resetAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('401 → AiAuthError；429 → AiRateLimitedError 带 retryAfter', async () => {
    const auth = recordingFetch(new Response('unauthorized', { status: 401 }));
    await expect(first(provider(auth.fetchImpl).chatStream({ model: 'm', messages: [] }))).rejects.toBeInstanceOf(
      AiAuthError,
    );

    const rate = recordingFetch(new Response('slow', { status: 429, headers: { 'retry-after': '3' } }));
    const err = await first(provider(rate.fetchImpl).chatStream({ model: 'm', messages: [] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRateLimitedError);
    expect((err as AiRateLimitedError).retryAfterMs).toBe(3000);
  });

  it('5xx → AiNetworkError 带 status', async () => {
    const { fetchImpl } = recordingFetch(new Response('boom', { status: 503 }));
    const err = await first(provider(fetchImpl).chatStream({ model: 'm', messages: [] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiNetworkError);
    expect((err as AiNetworkError).status).toBe(503);
  });

  it('流中服务端 error 事件 → 对应错误类（quota/auth/rate/provider）', async () => {
    const quota = recordingFetch(
      new Response(sseText(['{"error":{"code":"AI_QUOTA_EXCEEDED","message":"no quota"}}']), { status: 200 }),
    );
    await expect(first(provider(quota.fetchImpl).chatStream({ model: 'm', messages: [] }))).rejects.toBeInstanceOf(
      AiQuotaExceededError,
    );

    const auth = recordingFetch(
      new Response(sseText(['{"error":{"code":"AI_PROVIDER_AUTH_ERROR","message":"bad key"}}']), { status: 200 }),
    );
    await expect(first(provider(auth.fetchImpl).chatStream({ model: 'm', messages: [] }))).rejects.toBeInstanceOf(
      AiAuthError,
    );
  });

  it('chat()：聚合流式结果为非流式响应', async () => {
    const events = [
      '{"choices":[{"delta":{"content":"He"}}]}',
      '{"choices":[{"delta":{"content":"llo"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
    ];
    const { fetchImpl } = recordingFetch(new Response(sseText(events), { status: 200 }));
    const result = await provider(fetchImpl).chat({ model: 'm', messages: [] });
    expect(result.content).toBe('Hello');
    expect(result.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });

  it('调用方 abort → AiAbortError', async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText(['{"choices":[{"delta":{"content":"a"}}]}'])));
          signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const controller = new AbortController();
    const iterate = async () => {
      for await (const chunk of provider(fetchImpl).chatStream({ model: 'm', messages: [] }, controller.signal)) {
        controller.abort();
        void chunk;
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(AiAbortError);
  });

  it('getUsage：200 解析快照；401/网络失败返回 undefined', async () => {
    const ok = recordingFetch(
      new Response(
        JSON.stringify({
          usageMonth: '2026-10',
          limit: 100000,
          used: 12345,
          reserved: 100,
          remaining: 87555,
          requestCount: 3,
          resetAt: '2026-11-01T00:00:00.000Z',
        }),
        { status: 200 },
      ),
    );
    await expect(provider(ok.fetchImpl).getUsage()).resolves.toMatchObject({
      limit: 100000,
      used: 12345,
      remaining: 87555,
    });

    const unauthorized = recordingFetch(new Response('', { status: 401 }));
    await expect(provider(unauthorized.fetchImpl).getUsage()).resolves.toBeUndefined();
    await expect(provider((async () => { throw new Error('net'); }) as typeof fetch).getUsage()).resolves.toBeUndefined();
  });

  it('401 → 静默续期后重试一次成功（换新 token）', async () => {
    const responses = [
      new Response('unauthorized', { status: 401 }),
      new Response(sseText(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']), { status: 200 }),
    ];
    const { calls, fetchImpl } = recordingFetch(() => responses.shift()!);
    const refresh = vi.fn(async () => 'tok-2');
    const chunks = [];
    for await (const chunk of provider(fetchImpl, 'tok-1', refresh).chatStream({ model: 'm', messages: [] })) {
      chunks.push(chunk);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer tok-2');
    expect(chunks[0]).toMatchObject({ delta: 'ok' });
  });

  it('401 → 续期失败（undefined）→ AiAuthError，仅一次请求', async () => {
    const { calls, fetchImpl } = recordingFetch(new Response('unauthorized', { status: 401 }));
    const refresh = vi.fn(async () => undefined);
    const err = await first(provider(fetchImpl, 'tok-1', refresh).chatStream({ model: 'm', messages: [] })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiAuthError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('401 → 续期返回同一 token → 不重试（防死循环）', async () => {
    const { calls, fetchImpl } = recordingFetch(new Response('unauthorized', { status: 401 }));
    const refresh = vi.fn(async () => 'tok-1');
    const err = await first(provider(fetchImpl, 'tok-1', refresh).chatStream({ model: 'm', messages: [] })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiAuthError);
    expect(calls).toHaveLength(1);
  });

  it('getUsage：401 → 续期 → 200 快照', async () => {
    const responses = [
      new Response('unauthorized', { status: 401 }),
      new Response(JSON.stringify({ limit: 100, used: 1, remaining: 99 }), { status: 200 }),
    ];
    const { calls, fetchImpl } = recordingFetch(() => responses.shift()!);
    const refresh = vi.fn(async () => 'tok-2');
    await expect(provider(fetchImpl, 'tok-1', refresh).getUsage()).resolves.toMatchObject({ limit: 100, remaining: 99 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });
});