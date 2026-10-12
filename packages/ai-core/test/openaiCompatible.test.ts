import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../src/openaiCompatible.js';
import {
  AiAbortError,
  AiAuthError,
  AiNetworkError,
  AiProtocolError,
  AiQuotaExceededError,
  AiRateLimitedError,
  AiTimeoutError,
} from '../src/errors.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fetchReturning(response: Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const hangingFetch = ((_input: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as unknown as typeof fetch;

function provider(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://ai.test/v1/',
    apiKey: 'k1',
    fetchImpl,
    ...extra,
  });
}

describe('OpenAICompatibleProvider.chat', () => {
  it('拼接 URL / 认证头 / 请求体并解析响应与 usage', async () => {
    const body = {
      model: 'gpt-x',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const { calls, fetchImpl } = fetchReturning(new Response(JSON.stringify(body), { status: 200 }));
    const result = await provider(fetchImpl).chat({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0.2,
      maxTokens: 100,
    });

    expect(result).toEqual({
      content: 'hi',
      model: 'gpt-x',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    expect(calls[0].url).toBe('https://ai.test/v1/chat/completions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k1');
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ model: 'gpt-x', stream: false, temperature: 0.2, max_tokens: 100 });
  });

  it('未配置 apiKey 时不带 Authorization 头', async () => {
    const { calls, fetchImpl } = fetchReturning(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const p = new OpenAICompatibleProvider({ baseUrl: 'https://ai.test/v1', fetchImpl });
    await p.chat({ model: 'm', messages: [] });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('401/403 → AiAuthError', async () => {
    const { fetchImpl } = fetchReturning(new Response('unauthorized', { status: 401 }));
    await expect(provider(fetchImpl).chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(AiAuthError);
  });

  it('429 → AiRateLimitedError 且解析 Retry-After', async () => {
    const { fetchImpl } = fetchReturning(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }));
    const err = await provider(fetchImpl).chat({ model: 'm', messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRateLimitedError);
    expect((err as AiRateLimitedError).retryAfterMs).toBe(2000);
  });

  it('409 → AiQuotaExceededError 且携带配额信息', async () => {
    const body = JSON.stringify({ error: { code: 'AI_QUOTA_EXCEEDED', limit: 100, used: 100, resetAt: '2026-11-01' } });
    const { fetchImpl } = fetchReturning(new Response(body, { status: 409 }));
    const err = await provider(fetchImpl).chat({ model: 'm', messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiQuotaExceededError);
    expect((err as AiQuotaExceededError).quota).toMatchObject({ limit: 100, used: 100, resetAt: '2026-11-01' });
  });

  it('其他非 2xx → AiNetworkError 带 status', async () => {
    const { fetchImpl } = fetchReturning(new Response('boom', { status: 500 }));
    const err = await provider(fetchImpl).chat({ model: 'm', messages: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiNetworkError);
    expect((err as AiNetworkError).status).toBe(500);
  });

  it('200 但 JSON 非法 → AiProtocolError', async () => {
    const { fetchImpl } = fetchReturning(new Response('{oops', { status: 200 }));
    await expect(provider(fetchImpl).chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(AiProtocolError);
  });

  it('响应缺 choices[0].message.content → AiProtocolError', async () => {
    const { fetchImpl } = fetchReturning(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(provider(fetchImpl).chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(AiProtocolError);
  });

  it('超时 → AiTimeoutError', async () => {
    const p = provider(hangingFetch, { timeoutMs: 20 });
    await expect(p.chat({ model: 'm', messages: [] })).rejects.toBeInstanceOf(AiTimeoutError);
  });

  it('调用方 abort → AiAbortError', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(provider(hangingFetch).chat({ model: 'm', messages: [] }, controller.signal)).rejects.toBeInstanceOf(
      AiAbortError,
    );
  });

  it('baseUrl 为空 → 构造即抛 AI_NOT_CONFIGURED', () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: '  ' })).toThrowError(/baseUrl/);
  });
});

describe('OpenAICompatibleProvider.chatStream', () => {
  it('流式解析 delta / finish_reason / usage，[DONE] 停止', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"He"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    const { calls, fetchImpl } = fetchReturning(new Response(sse, { status: 200 }));
    const chunks = [];
    for await (const chunk of provider(fetchImpl).chatStream({ model: 'm', messages: [] })) chunks.push(chunk);

    expect(chunks).toEqual([
      { delta: 'He', finishReason: undefined, usage: undefined },
      { delta: 'llo', finishReason: undefined, usage: undefined },
      {
        delta: undefined,
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      },
    ]);
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toBeUndefined();
  });

  it('streamOptions.includeUsage → 流式请求体带 stream_options.include_usage', async () => {
    const sse = ['data: [DONE]', '', ''].join('\n');
    const { calls, fetchImpl } = fetchReturning(new Response(sse, { status: 200 }));
    const iterate = async () => {
      for await (const _chunk of provider(fetchImpl).chatStream({
        model: 'm',
        messages: [],
        streamOptions: { includeUsage: true },
      })) void _chunk;
    };
    await iterate();
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(payload.stream_options).toEqual({ include_usage: true });
  });

  it('非流式请求不携带 stream_options（即便传了 streamOptions）', async () => {
    const body = { choices: [{ message: { content: 'ok' } }] };
    const { calls, fetchImpl } = fetchReturning(new Response(JSON.stringify(body), { status: 200 }));
    await provider(fetchImpl).chat({ model: 'm', messages: [], streamOptions: { includeUsage: true } });
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(payload.stream_options).toBeUndefined();
  });

  it('流中 payload 非法 → AiProtocolError', async () => {
    const { fetchImpl } = fetchReturning(new Response('data: {oops\n\n', { status: 200 }));
    const iterate = async () => {
      for await (const _chunk of provider(fetchImpl).chatStream({ model: 'm', messages: [] })) void _chunk;
    };
    await expect(iterate()).rejects.toBeInstanceOf(AiProtocolError);
  });

  it('流中 abort → AiAbortError', async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
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
});