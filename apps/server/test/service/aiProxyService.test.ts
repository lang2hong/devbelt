import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { AiProxyService, MAX_COMPLETION_TOKENS, estimatePromptTokens } from '../../src/modules/ai/service/aiProxyService.js';
import type { AiQuotaService, AiReservation } from '../../src/modules/ai/service/aiQuotaService.js';
import { AiProviderError } from '../../src/modules/ai/domain/errors.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';

/** 最小 ServerResponse 假实现：记录 writeHead/write/end，可手动触发 'close'（客户端断开）。 */
class FakeRes extends EventEmitter {
  status: number | undefined;
  headers: Record<string, string> | undefined;
  chunks: string[] = [];
  headersSent = false;
  writableEnded = false;
  destroyed = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): this {
    if (chunk) this.chunks.push(chunk);
    this.writableEnded = true;
    return this;
  }

  /** 模拟客户端断开：destroy + 'close'。 */
  clientDisconnect(): void {
    this.destroyed = true;
    this.emit('close');
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
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

function quotaStub(overrides: { settle?: (reservation: AiReservation, charge: { promptTokens: number; completionTokens: number }) => Promise<void> } = {}): {
  reserve: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  quota: AiQuotaService;
} {
  const reserve = vi.fn(
    async (userId: number, opts: { estimatedPromptTokens: number; maxCompletionTokens: number }) => ({
      userId,
      usageMonth: '2026-10',
      estimatedPromptTokens: opts.estimatedPromptTokens,
      reservedPromptTokens: opts.estimatedPromptTokens,
      reservedCompletionTokens: opts.maxCompletionTokens,
      limit: 100_000,
      resetAt: '2026-11-01T00:00:00.000Z',
    }),
  );
  const settle = vi.fn(overrides.settle ?? (async () => {}));
  const getUsage = vi.fn();
  return { reserve, settle, quota: { reserve, settle, getUsage } as unknown as AiQuotaService };
}

function buildService(opts: {
  fetchImpl: typeof fetch;
  quota: AiQuotaService;
  configured?: boolean;
  auditRepo?: FakeAuditRepo;
  log?: (msg: string, data?: unknown) => void;
}): { service: AiProxyService; auditRepo: FakeAuditRepo; logs: string[] } {
  const auditRepo = opts.auditRepo ?? new FakeAuditRepo();
  const logs: string[] = [];
  const service = new AiProxyService({
    config: {
      configured: opts.configured ?? true,
      baseUrl: 'https://upstream.test/v1',
      apiKey: 'up-secret',
      model: 'qwen-test',
    },
    quota: opts.quota,
    audit: new AuditWriter(auditRepo),
    log: opts.log ?? ((msg) => logs.push(msg)),
    fetchImpl: opts.fetchImpl,
  });
  return { service, auditRepo, logs };
}

const RESERVATION: AiReservation = {
  userId: 7,
  usageMonth: '2026-10',
  estimatedPromptTokens: 100,
  reservedPromptTokens: 100,
  reservedCompletionTokens: 4096,
  limit: 100_000,
  resetAt: '2026-11-01T00:00:00.000Z',
};

const BODY = {
  messages: [{ role: 'user' as const, content: '你好' }],
  maxTokens: MAX_COMPLETION_TOKENS,
  feature: 'chat' as const,
};

describe('AiProxyService.validate', () => {
  const { service } = buildService({ fetchImpl: (async () => new Response('')) as typeof fetch, quota: quotaStub().quota });

  it('拒绝非对象 / 空 messages / 非法 role / 超长内容', () => {
    expect(() => service.validate(null)).toThrowError(/JSON object/);
    expect(() => service.validate({ messages: [] })).toThrowError(/non-empty/);
    expect(() => service.validate({ messages: [{ role: 'tool', content: 'x' }] })).toThrowError(/role/);
    expect(() => service.validate({ messages: [{ role: 'user', content: '' }] })).toThrowError(/content/);
    expect(() => service.validate({ messages: [{ role: 'user', content: 'x'.repeat(60_001) }] })).toThrowError(/60000/);
    expect(() =>
      service.validate({
        messages: [
          { role: 'user', content: 'x'.repeat(60_000) },
          { role: 'user', content: 'x'.repeat(60_000) },
          { role: 'user', content: 'x' },
        ],
      }),
    ).toThrowError(/total length/);
  });

  it('maxTokens 收敛到 [1, 4096]，temperature/feature 校验', () => {
    expect(service.validate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 99_999 }).maxTokens).toBe(
      MAX_COMPLETION_TOKENS,
    );
    expect(service.validate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 0 }).maxTokens).toBe(1);
    expect(service.validate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 128 }).maxTokens).toBe(128);
    expect(service.validate({ messages: [{ role: 'user', content: 'x' }], feature: 'nl2sql' }).feature).toBe('nl2sql');
    expect(() => service.validate({ messages: [{ role: 'user', content: 'x' }], temperature: 3 })).toThrowError(
      /temperature/,
    );
    expect(() => service.validate({ messages: [{ role: 'user', content: 'x' }], feature: 'evil' })).toThrowError(
      /feature/,
    );
  });
});

describe('AiProxyService.begin', () => {
  it('未配置上游 → AI_PROVIDER_ERROR(503)', async () => {
    const { service } = buildService({
      fetchImpl: (async () => new Response('')) as typeof fetch,
      quota: quotaStub().quota,
      configured: false,
    });
    const err = await service.begin(1, BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).code).toBe('AI_PROVIDER_ERROR');
  });

  it('已配置 → 按估算 prompt + completion 上限预占', async () => {
    const { reserve, quota } = quotaStub();
    const { service } = buildService({ fetchImpl: (async () => new Response('')) as typeof fetch, quota });
    const reservation = await service.begin(1, BODY);
    expect(reservation.usageMonth).toBe('2026-10');
    expect(reserve).toHaveBeenCalledTimes(1);
    const [userId, opts] = reserve.mock.calls[0] as [number, { estimatedPromptTokens: number; maxCompletionTokens: number }];
    expect(userId).toBe(1);
    expect(opts.estimatedPromptTokens).toBe(estimatePromptTokens(BODY.messages));
    expect(opts.maxCompletionTokens).toBe(MAX_COMPLETION_TOKENS);
  });
});

describe('AiProxyService.forward（parse-and-forward）', () => {
  it('原样转发事件 + 强制 stream_options.include_usage + finish usage 权威结算 + 审计', async () => {
    const events = [
      '{"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
      '{"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128}}',
    ];
    const { calls, fetchImpl } = recordingFetch(new Response(sseText(events), { status: 200 }));
    const { settle, quota } = quotaStub();
    const { service, auditRepo } = buildService({ fetchImpl, quota });
    const res = new FakeRes();

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    expect(calls[0].url).toBe('https://upstream.test/v1/chat/completions');
    const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ model: 'qwen-test', stream: true, stream_options: { include_usage: true } });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer up-secret');

    expect(res.status).toBe(200);
    expect(res.headers?.['Content-Type']).toContain('text/event-stream');
    const body = res.chunks.join('');
    for (const e of events) expect(body).toContain(`data: ${e}\n\n`);
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true);

    expect(settle).toHaveBeenCalledWith(RESERVATION, { promptTokens: 120, completionTokens: 8 });
    const completed = auditRepo.events.find((e) => e.eventType === 'ai.chat.completed');
    expect(completed).toBeDefined();
    expect(JSON.parse(String(completed?.reason))).toMatchObject({
      model: 'qwen-test',
      promptTokens: 120,
      completionTokens: 8,
      usageEstimated: false,
    });
  });

  it('上游未返回 usage → delta 估算结算并打 usageEstimated=true', async () => {
    const events = [
      '{"choices":[{"delta":{"content":"你好"}}]}',
      '{"choices":[{"delta":{"content":" world"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ];
    const { fetchImpl } = recordingFetch(new Response(sseText(events), { status: 200 }));
    const { settle, quota } = quotaStub();
    const { service, auditRepo } = buildService({ fetchImpl, quota });
    const res = new FakeRes();

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    expect(settle).toHaveBeenCalledWith(RESERVATION, { promptTokens: 100, completionTokens: 4 });
    const completed = auditRepo.events.find((e) => e.eventType === 'ai.chat.completed');
    expect(JSON.parse(String(completed?.reason))).toMatchObject({ usageEstimated: true, completionTokens: 4 });
  });

  it('单 chunk 非法 JSON：不中断流、原样转发、审计 warn 后继续', async () => {
    const events = [
      '{"choices":[{"delta":{"content":"a"}}]}',
      '{oops',
      '{"choices":[{"delta":{"content":"b"}}]}',
    ];
    const { fetchImpl } = recordingFetch(new Response(sseText(events), { status: 200 }));
    const { settle, quota } = quotaStub();
    const { service, auditRepo } = buildService({ fetchImpl, quota });
    const res = new FakeRes();

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    const body = res.chunks.join('');
    expect(body).toContain('data: {oops\n\n');
    expect(body).toContain('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
    expect(auditRepo.events.some((e) => e.eventType === 'ai.sse.chunk_parse_failed')).toBe(true);
    expect(settle).toHaveBeenCalledWith(RESERVATION, { promptTokens: 100, completionTokens: 2 });
  });

  it('客户端断开：abort 上游、按已下发 delta 估算结算、审计 aborted', async () => {
    let aborted = false;
    const encoder = new TextEncoder();
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseText(['{"choices":[{"delta":{"content":"你好"}}]}'])));
          signal.addEventListener('abort', () => {
            aborted = true;
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const { settle, quota } = quotaStub();
    const { service, auditRepo } = buildService({ fetchImpl, quota });

    const res = new FakeRes();
    const originalWrite = res.write.bind(res);
    res.write = (chunk: string): boolean => {
      const result = originalWrite(chunk);
      if (!res.destroyed) res.clientDisconnect();
      return result;
    };

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    expect(aborted).toBe(true);
    expect(settle).toHaveBeenCalledWith(RESERVATION, { promptTokens: 100, completionTokens: 2 });
    const abortedEvent = auditRepo.events.find((e) => e.eventType === 'ai.chat.aborted');
    expect(abortedEvent).toBeDefined();
    expect(abortedEvent?.failureCode).toBe('AI_ABORTED');
  });

  it('上游 401 → 预流 JSON 401 AI_PROVIDER_AUTH_ERROR、0 结算、审计 failed', async () => {
    const { fetchImpl } = recordingFetch(new Response('unauthorized', { status: 401 }));
    const { settle, quota } = quotaStub();
    const { service, auditRepo } = buildService({ fetchImpl, quota });
    const res = new FakeRes();

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    expect(res.status).toBe(401);
    expect(JSON.parse(res.chunks.join(''))).toEqual({
      message: expect.any(String),
      code: 'AI_PROVIDER_AUTH_ERROR',
    });
    expect(settle).toHaveBeenCalledWith(RESERVATION, { promptTokens: 0, completionTokens: 0 });
    const failed = auditRepo.events.find((e) => e.eventType === 'ai.chat.failed');
    expect(failed?.failureCode).toBe('AI_PROVIDER_AUTH_ERROR');
  });

  it('上游 429 → 预流 429 + Retry-After', async () => {
    const { fetchImpl } = recordingFetch(
      new Response('slow', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const { quota } = quotaStub();
    const { service } = buildService({ fetchImpl, quota });
    const res = new FakeRes();

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    expect(res.status).toBe(429);
    expect(res.headers?.['Retry-After']).toBe('3');
    expect(JSON.parse(res.chunks.join('')).code).toBe('AI_RATE_LIMITED');
  });

  it('网络错误 → 503 AI_PROVIDER_ERROR，不泄漏底层错误文本', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed: secret-ish detail');
    }) as typeof fetch;
    const { quota } = quotaStub();
    const { service, auditRepo } = buildService({ fetchImpl, quota });
    const res = new FakeRes();

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    expect(res.status).toBe(503);
    const body = JSON.parse(res.chunks.join('')) as { code: string; message: string };
    expect(body.code).toBe('AI_PROVIDER_ERROR');
    expect(body.message).not.toContain('secret-ish');
    expect(auditRepo.events.find((e) => e.eventType === 'ai.chat.failed')).toBeDefined();
  });

  it('结算失败不抛出（仅告警），响应已完成', async () => {
    const { fetchImpl } = recordingFetch(new Response(sseText(['[DONE]']), { status: 200 }));
    const { quota } = quotaStub({ settle: async () => { throw new Error('db down'); } });
    const logs: string[] = [];
    const { service } = buildService({ fetchImpl, quota, log: (msg) => logs.push(msg) });
    const res = new FakeRes();

    await service.forward({ userId: 7, body: BODY, reservation: RESERVATION, res: res.asServerResponse() });

    expect(res.writableEnded).toBe(true);
    expect(logs).toContain('ai quota settle failed');
  });

  it('estimatePromptTokens：CJK 1 字 ≈ 1 token + 结构开销', () => {
    expect(estimatePromptTokens([{ role: 'user', content: '你好' }])).toBe(2 + 4 + 16);
    expect(estimatePromptTokens([{ role: 'user', content: 'hello world' }])).toBe(3 + 4 + 16);
  });
});