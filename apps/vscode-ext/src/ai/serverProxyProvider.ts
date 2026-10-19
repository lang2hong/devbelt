import type { AiProvider, ChatRequest, ChatResponse, ChatStreamChunk, TokenUsage } from '@devbelt/ai-core';
import {
  AiAbortError,
  AiAuthError,
  AiError,
  AiNetworkError,
  AiProtocolError,
  AiQuotaExceededError,
  AiRateLimitedError,
  AiTimeoutError,
  parseSse,
} from '@devbelt/ai-core';
import { AiLoginRequiredError } from './aiErrors.js';

/** 服务端 `GET /api/ai/usage` 快照（与 apps/server AiQuotaSnapshot 对齐）。 */
export interface AiUsageSnapshot {
  usageMonth: string;
  limit: number;
  used: number;
  reserved: number;
  /** 月段剩余（P9.1；旧服务端缺失时回退 remaining）。 */
  monthlyRemaining: number;
  /** 加油包可用余额（P9.1；旧服务端缺失时为 0）。 */
  topupRemaining: number;
  /** 合计可用 = monthlyRemaining + topupRemaining。 */
  remaining: number;
  requestCount: number;
  resetAt: string;
}

export interface ServerProxyOptions {
  /** DevBelt server 根地址（如 `https://host`）；路径 `/api/ai/chat` 由本类拼接。 */
  serverUrl: string;
  /** 动态读取 access token（AuthService 会随刷新/登出变化）。 */
  getAccessToken: () => string | undefined;
  /**
   * 401 时的静默续期（返回新 access token；失败/缺省则按授权错误处理）。
   * 用于 token 过期后自动重试一次（对齐 SyncClient 既有语义；refresh 单飞由 AuthService 保证）。
   */
  onAuthFailure?: () => Promise<string | undefined>;
  /** 请求超时（毫秒），默认 60s（与服务端上游超时同量级）。 */
  timeoutMs?: number;
  /** 测试注入；生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const ERROR_SNIPPET_CHARS = 300;

/**
 * 服务端代理 Provider（P9 S3）：行为与 `OpenAICompatibleProvider` 对齐，
 * 但端点是 DevBelt server `/api/ai/chat`（SSE，服务端做 parse-and-forward），
 * Authorization 用现有 auth access token（每请求动态读取）。
 *
 * 错误映射：409 → `AiQuotaExceededError`（携带 limit/used/reserved/resetAt，
 * 面板配额条展示）；401/403 → `AiAuthError`（登录过期，提示重登）；
 * 429 → `AiRateLimitedError`；流中服务端 error 事件按 code 还原为对应错误。
 */
export class ServerProxyProvider implements AiProvider {
  readonly id = 'server-proxy';

  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ServerProxyOptions) {
    const base = opts.serverUrl?.trim().replace(/\/+$/, '');
    if (!base) throw new AiError('AI_NOT_CONFIGURED', 'server url is required');
    this.serverUrl = base;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 非流式：聚合 SSE 流（服务端仅提供流式端点）。 */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    let content = '';
    let usage: TokenUsage | undefined;
    for await (const chunk of this.chatStream(request, signal)) {
      if (chunk.delta) content += chunk.delta;
      if (chunk.usage) usage = chunk.usage;
    }
    return { content, usage, model: request.model };
  }

  async *chatStream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamChunk> {
    const token = this.opts.getAccessToken();
    if (!token) throw new AiLoginRequiredError();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const relayAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', relayAbort, { once: true });
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
    };

    try {
      const open = (accessToken: string): Promise<Response> =>
        this.fetchImpl(`${this.serverUrl}/api/ai/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
            ...(request.feature !== undefined ? { feature: request.feature } : {}),
          }),
          signal: controller.signal,
        });

      let response = await open(token);
      // 401（access token 过期/被撤销）→ 静默续期一次后重试；只重试一次，失败路径与原行为一致。
      if (response.status === 401 && this.opts.onAuthFailure) {
        const refreshed = await this.opts.onAuthFailure().catch(() => undefined);
        if (refreshed && refreshed !== token && !controller.signal.aborted) {
          response = await open(refreshed);
        }
      }
      if (!response.ok) throw await this.toHttpError(response);
      clearTimeout(timer);
      if (!response.body) throw new AiProtocolError('AI proxy response has no body');

      for await (const event of parseSse(response.body)) {
        if (event.data === '[DONE]') return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(event.data) as Record<string, unknown>;
        } catch (err) {
          throw new AiProtocolError(
            `AI proxy sent an invalid payload: ${truncate(event.data, ERROR_SNIPPET_CHARS)}`,
            err,
          );
        }
        const serverError = parsed.error as Record<string, unknown> | undefined;
        if (serverError && typeof serverError.code === 'string') {
          throw mapServerErrorEvent(serverError.code, serverError.message);
        }
        const choices = parsed.choices;
        const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
        const deltaRaw = choice?.delta as Record<string, unknown> | undefined;
        const delta = typeof deltaRaw?.content === 'string' && deltaRaw.content.length > 0 ? deltaRaw.content : undefined;
        // 推理模型：DashScope/DeepSeek 用 reasoning_content，部分网关用 reasoning。
        const reasoningRaw = deltaRaw?.reasoning_content ?? deltaRaw?.reasoning;
        const reasoning = typeof reasoningRaw === 'string' && reasoningRaw.length > 0 ? reasoningRaw : undefined;
        const finishReason = normalizeFinishReason(choice?.finish_reason);
        const usage = mapUsage(parsed.usage);
        if (delta !== undefined || reasoning !== undefined || finishReason !== undefined || usage !== undefined) {
          yield { delta, ...(reasoning !== undefined ? { reasoning } : {}), finishReason, usage };
        }
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (isAbortLike(err)) {
        throw timedOut
          ? new AiTimeoutError(`AI request timed out after ${this.timeoutMs}ms`)
          : new AiAbortError('AI request aborted');
      }
      throw new AiNetworkError(`AI request failed: ${errorMessage(err)}`, undefined, err);
    } finally {
      finish();
    }
  }

  /** `GET /api/ai/usage`：本月额度快照（面板配额条；server-proxy 模式专用）。 */
  async getUsage(): Promise<AiUsageSnapshot | undefined> {
    const token = this.opts.getAccessToken();
    if (!token) return undefined;
    try {
      const open = (accessToken: string): Promise<Response> =>
        this.fetchImpl(`${this.serverUrl}/api/ai/usage`, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        });
      let response = await open(token);
      if (response.status === 401 && this.opts.onAuthFailure) {
        const refreshed = await this.opts.onAuthFailure().catch(() => undefined);
        if (refreshed && refreshed !== token) response = await open(refreshed);
      }
      if (!response.ok) return undefined;
      const body = (await response.json()) as Partial<AiUsageSnapshot>;
      if (typeof body.limit !== 'number' || typeof body.used !== 'number') return undefined;
      const remaining = typeof body.remaining === 'number' ? body.remaining : Math.max(0, body.limit - body.used);
      return {
        usageMonth: typeof body.usageMonth === 'string' ? body.usageMonth : '',
        limit: body.limit,
        used: body.used,
        reserved: typeof body.reserved === 'number' ? body.reserved : 0,
        // 旧服务端（P9.1 前）无双段字段：月段回退合计、加油包记 0。
        monthlyRemaining: typeof body.monthlyRemaining === 'number' ? body.monthlyRemaining : remaining,
        topupRemaining: typeof body.topupRemaining === 'number' ? body.topupRemaining : 0,
        remaining,
        requestCount: typeof body.requestCount === 'number' ? body.requestCount : 0,
        resetAt: typeof body.resetAt === 'string' ? body.resetAt : '',
      };
    } catch {
      return undefined;
    }
  }

  private async toHttpError(response: Response): Promise<AiError> {
    const status = response.status;
    if (status === 401 || status === 403) return new AiAuthError(`AI proxy authentication failed (HTTP ${status})`);
    if (status === 429) {
      return new AiRateLimitedError(parseRetryAfterMs(response.headers.get('retry-after')), 'AI rate limited (HTTP 429)');
    }
    if (status === 409) {
      const text = await response.text().catch(() => '');
      return new AiQuotaExceededError(parseQuotaInfo(text), 'AI monthly quota exceeded');
    }
    const snippet = truncate(await response.text().catch(() => ''), ERROR_SNIPPET_CHARS);
    return new AiNetworkError(`AI request failed (HTTP ${status})${snippet ? `: ${snippet}` : ''}`, status);
  }
}

function mapServerErrorEvent(code: string, message: unknown): AiError {
  const text = typeof message === 'string' && message ? message : 'AI stream interrupted';
  switch (code) {
    case 'AI_QUOTA_EXCEEDED':
      return new AiQuotaExceededError(undefined, text);
    case 'AI_RATE_LIMITED':
      return new AiRateLimitedError(undefined, text);
    case 'AI_PROVIDER_AUTH_ERROR':
      return new AiAuthError(text);
    default:
      return new AiNetworkError(text, 503);
  }
}

function parseQuotaInfo(text: string): { limit?: number; used?: number; reserved?: number; resetAt?: string } | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const quota: { limit?: number; used?: number; reserved?: number; resetAt?: string } = {};
    const limit = toFiniteNumber(body.limit);
    const used = toFiniteNumber(body.used);
    const reserved = toFiniteNumber(body.reserved);
    if (limit !== undefined) quota.limit = limit;
    if (used !== undefined) quota.used = used;
    if (reserved !== undefined) quota.reserved = reserved;
    if (typeof body.resetAt === 'string') quota.resetAt = body.resetAt;
    return Object.keys(quota).length > 0 ? quota : undefined;
  } catch {
    return undefined;
  }
}

function mapUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = toFiniteNumber(u.prompt_tokens);
  const completion = toFiniteNumber(u.completion_tokens);
  const total = toFiniteNumber(u.total_tokens);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    totalTokens: total ?? (prompt ?? 0) + (completion ?? 0),
  };
}

function normalizeFinishReason(value: unknown): ChatStreamChunk['finishReason'] {
  if (value === 'stop' || value === 'length' || value === 'content_filter') return value;
  return undefined;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}