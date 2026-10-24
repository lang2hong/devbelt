import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AiAbortError } from '@devbelt/ai-core';
import { AiService, type AiAuthLike, type AiConfig } from '../../src/ai/aiService';
import { AiLoginRequiredError, AiNotConfiguredError } from '../../src/ai/aiErrors';
import type { AiKeyStore } from '../../src/ai/aiKeyStore';
import type { AuditLogger } from '../../src/utils/auditLogger';

function keyStoreWith(key?: string): AiKeyStore {
  return {
    getApiKey: async () => key,
    hasApiKey: async () => key !== undefined,
    setApiKey: async () => {},
    clearApiKey: async () => {},
    dispose: () => {},
  } as unknown as AiKeyStore;
}

function authLike(opts: {
  loggedIn: boolean;
  entitlement?: unknown;
  token?: string;
  refreshAccessToken?: () => Promise<string | undefined>;
}): AiAuthLike {
  return {
    isLoggedIn: () => opts.loggedIn,
    getAccessToken: () => opts.token ?? (opts.loggedIn ? 'tok' : undefined),
    getCachedEntitlement: () => opts.entitlement as never,
    ...(opts.refreshAccessToken ? { refreshAccessToken: opts.refreshAccessToken } : {}),
  };
}

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'server-proxy',
    baseUrl: '',
    model: 'm1',
    includeColumnComments: true,
    temperature: 0.2,
    schemaContextMode: 'current-db',
    dataSampleRows: 10,
    ...overrides,
  };
}

function sseResponse(events: string[]): Response {
  return new Response(events.map((e) => `data: ${e}\n\n`).join(''), { status: 200 });
}

function recordingFetch(response: Response | (() => Response)): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('AiService（双 provider 路由）', () => {
  it('server-proxy 未登录 → AiLoginRequiredError', async () => {
    const service = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: false }),
      serverUrl: 'https://server.test',
      getConfig: () => config(),
      fetchImpl: recordingFetch(new Response('')).fetchImpl,
    });
    await expect(collect(service.streamChat({ model: 'm', messages: [] }, { feature: 'chat' }))).rejects.toBeInstanceOf(
      AiLoginRequiredError,
    );
  });

  it('byok 缺 model/baseUrl/apiKey → AiNotConfiguredError', async () => {
    const noModel = new AiService({
      keyStore: keyStoreWith('k'),
      auth: authLike({ loggedIn: false }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'openai-compatible', baseUrl: 'https://ai.test/v1', model: '' }),
    });
    await expect(
      collect(noModel.streamChat({ model: 'm', messages: [] }, { feature: 'chat' })),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);

    const noKey = new AiService({
      keyStore: keyStoreWith(undefined),
      auth: authLike({ loggedIn: false }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'openai-compatible', baseUrl: 'https://ai.test/v1', model: 'm1' }),
    });
    await expect(
      collect(noKey.streamChat({ model: 'm', messages: [] }, { feature: 'chat' })),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it('byok 直连上游 /chat/completions 并带 Bearer apiKey', async () => {
    const { calls, fetchImpl } = recordingFetch(sseResponse(['[DONE]']));
    const service = new AiService({
      keyStore: keyStoreWith('sk-abc'),
      auth: authLike({ loggedIn: false }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'openai-compatible', baseUrl: 'https://ai.test/v1', model: 'gpt-x' }),
      fetchImpl,
    });
    await collect(service.streamChat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] }, { feature: 'chat' }));
    expect(calls[0].url).toBe('https://ai.test/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc');
  });

  it('server-proxy 走 /api/ai/chat 并带 access token', async () => {
    const { calls, fetchImpl } = recordingFetch(sseResponse(['[DONE]']));
    const service = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true, token: 'access-1' }),
      serverUrl: 'https://server.test',
      getConfig: () => config(),
      fetchImpl,
    });
    await collect(service.streamChat({ model: 'm', messages: [] }, { feature: 'chat' }));
    expect(calls[0].url).toBe('https://server.test/api/ai/chat');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('abort() 中止底层请求 → AiAbortError', async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const service = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true }),
      serverUrl: 's',
      getConfig: () => config(),
      fetchImpl,
    });
    const text = 'hello';
    const stream = service.streamChat({ model: 'm', messages: [{ role: 'user', content: text }] }, { feature: 'chat' });
    const run = async () => {
      for await (const _chunk of stream) {
        stream.abort();
      }
    };
    await expect(run()).rejects.toBeInstanceOf(AiAbortError);
  });

  it('chat() 支持外部 AbortSignal（取消在途请求）', async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const service = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true }),
      serverUrl: 's',
      getConfig: () => config(),
      fetchImpl,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      service.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { feature: 'chat' }, controller.signal),
    ).rejects.toBeInstanceOf(AiAbortError);
  });

  it('describeProvider：server-proxy 不透出本地模型（模型由服务端决定）', async () => {
    const byokModel = new AiService({
      keyStore: keyStoreWith('k'),
      auth: authLike({ loggedIn: true }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'server-proxy', model: 'deepseek-v4.1-flash' }),
    });
    await expect(byokModel.describeProvider()).resolves.toMatchObject({ mode: 'server-proxy', model: '', baseUrl: '' });

    const byok = new AiService({
      keyStore: keyStoreWith('k'),
      auth: authLike({ loggedIn: true }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'openai-compatible', baseUrl: 'https://ai.test/v1', model: 'm1' }),
    });
    await expect(byok.describeProvider()).resolves.toMatchObject({ mode: 'openai-compatible', model: 'm1' });
  });

  it('describeProvider：登录缺失 / API Key 缺失 / 未配置 三类 reason', async () => {
    const proxy = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: false }),
      serverUrl: 's',
      getConfig: () => config(),
    });
    await expect(proxy.describeProvider()).resolves.toMatchObject({ mode: 'server-proxy', available: false, reason: 'login-required' });

    const byokNoKey = new AiService({
      keyStore: keyStoreWith(undefined),
      auth: authLike({ loggedIn: false }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'openai-compatible', baseUrl: 'https://ai.test/v1', model: 'm' }),
    });
    await expect(byokNoKey.describeProvider()).resolves.toMatchObject({ available: false, reason: 'api-key-missing' });

    const byokNoConfig = new AiService({
      keyStore: keyStoreWith('k'),
      auth: authLike({ loggedIn: false }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'openai-compatible', baseUrl: '', model: '' }),
    });
    await expect(byokNoConfig.describeProvider()).resolves.toMatchObject({ available: false, reason: 'not-configured' });
  });

  it('quotaLimit：entitlement fail-closed（缺省 0，有值透出）', () => {
    const withLimit = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true, entitlement: { maxAiTokensMonthly: 100000 } }),
      serverUrl: 's',
      getConfig: () => config(),
    });
    expect(withLimit.quotaLimit()).toBe(100000);

    const withoutLimit = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true, entitlement: {} }),
      serverUrl: 's',
      getConfig: () => config(),
    });
    expect(withoutLimit.quotaLimit()).toBe(0);
  });

  it('fetchUsage：仅 server-proxy 且登录时返回快照；byok 恒 undefined', async () => {
    const { fetchImpl } = recordingFetch(
      new Response(JSON.stringify({ limit: 100, used: 1, remaining: 99, usageMonth: '2026-10', resetAt: 'x' }), {
        status: 200,
      }),
    );
    const proxy = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true }),
      serverUrl: 'https://server.test',
      getConfig: () => config(),
      fetchImpl,
    });
    await expect(proxy.fetchUsage()).resolves.toMatchObject({ limit: 100, remaining: 99 });

    const byok = new AiService({
      keyStore: keyStoreWith('k'),
      auth: authLike({ loggedIn: true }),
      serverUrl: 's',
      getConfig: () => config({ provider: 'openai-compatible', baseUrl: 'https://ai.test/v1', model: 'm' }),
    });
    await expect(byok.fetchUsage()).resolves.toBeUndefined();
  });

  it('每次请求写一条审计（action=ai_chat，不含正文）', async () => {
    const log = vi.fn();
    const { fetchImpl } = recordingFetch(sseResponse(['[DONE]']));
    const service = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true }),
      serverUrl: 's',
      getConfig: () => config(),
      audit: { log } as unknown as AuditLogger,
      fetchImpl,
    });
    await collect(
      service.streamChat({ model: 'm', messages: [{ role: 'user', content: 'SECRET-PROMPT' }] }, { feature: 'chat', connName: 'c1' }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).toMatchObject({ action: 'ai_chat', connName: 'c1' });
    expect(JSON.stringify(entry)).not.toContain('SECRET-PROMPT');
  });

  it('estimatePromptTokens：CJK 与英文粗估', () => {
    expect(AiService.estimatePromptTokens([{ content: '你好' }])).toBe(2);
    expect(AiService.estimatePromptTokens([{ content: 'hello world' }])).toBe(3);
  });

  it('server-proxy：401 自动续期并重试一次（AuthService.refreshAccessToken 注入）', async () => {
    let n = 0;
    const fetchImpl = (async () =>
      (n += 1) === 1 ? new Response('unauthorized', { status: 401 }) : sseResponse(['[DONE]'])) as typeof fetch;
    const refresh = vi.fn(async () => 'tok-2');
    const service = new AiService({
      keyStore: keyStoreWith(),
      auth: authLike({ loggedIn: true, refreshAccessToken: refresh }),
      serverUrl: 's',
      getConfig: () => config(),
      fetchImpl,
    });
    await collect(service.streamChat({ model: 'm', messages: [] }, { feature: 'chat' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(n).toBe(2);
  });
});