import type { AiProvider } from './provider.js';
import type { ChatRequest, ChatResponse, ChatStreamChunk, ToolCall, ToolCallDelta } from './chat.js';
import type { TokenUsage } from './usage.js';
import { parseSse } from './sse.js';
import {
  AiAbortError,
  AiAuthError,
  AiError,
  AiNetworkError,
  AiProtocolError,
  AiQuotaExceededError,
  AiRateLimitedError,
  AiTimeoutError,
  type AiQuotaInfo,
} from './errors.js';

export interface OpenAICompatibleOptions {
  /** 兼容端点根地址（含版本段，如 `https://host/v1`）；路径 `/chat/completions` 由本类拼接。 */
  baseUrl: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  /** 请求超时（毫秒），默认 30s。 */
  timeoutMs?: number;
  /** 测试注入；生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_SNIPPET_CHARS = 300;

/**
 * OpenAI 兼容 Provider：覆盖 OpenAI / 百炼 DashScope 兼容模式 / DeepSeek /
 * Moonshot / 智谱 / Ollama / vLLM / SGLang 等任何 `POST /chat/completions` 服务。
 * 零第三方依赖（Node 内置 fetch + 自研 SSE 解析）。
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly id = 'openai-compatible';

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    const baseUrl = options.baseUrl?.trim().replace(/\/+$/, '');
    if (!baseUrl) throw new AiError('AI_NOT_CONFIGURED', 'AI baseUrl is required');
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey?.trim() ? options.apiKey.trim() : undefined;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const handle = await this.send(request, false, signal);
    try {
      const response = handle.response;
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        if (isAbortLike(err)) throw err;
        throw new AiProtocolError('AI response is not valid JSON', err);
      }
      const content = extractContent(body);
      const message = extractMessage(body);
      const toolCalls = parseToolCalls(message?.tool_calls);
      if (content === undefined && toolCalls.length === 0) {
        throw new AiProtocolError('AI response is missing choices[0].message.content');
      }
      const raw = body as Record<string, unknown>;
      const model = typeof raw.model === 'string' ? raw.model : request.model;
      return {
        content: content ?? '',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: mapUsage(raw.usage),
        model,
      };
    } catch (err) {
      throw mapError(err, handle);
    } finally {
      handle.finish();
    }
  }

  async *chatStream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamChunk> {
    const handle = await this.send(request, true, signal);
    try {
      const body = handle.response.body;
      if (!body) throw new AiProtocolError('AI streaming response has no body');
      for await (const event of parseSse(body)) {
        if (event.data === '[DONE]') return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(event.data) as Record<string, unknown>;
        } catch (err) {
          throw new AiProtocolError(`AI stream sent an invalid payload: ${truncate(event.data, ERROR_SNIPPET_CHARS)}`, err);
        }
        const choices = parsed.choices;
        const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
        const deltaRaw = choice?.delta as Record<string, unknown> | undefined;
        const delta = typeof deltaRaw?.content === 'string' && deltaRaw.content.length > 0 ? deltaRaw.content : undefined;
        const toolCalls = parseToolCallDeltas(deltaRaw?.tool_calls);
        const finishReason = normalizeFinishReason(choice?.finish_reason);
        const usage = mapUsage(parsed.usage);
        if (delta !== undefined || toolCalls.length > 0 || finishReason !== undefined || usage !== undefined) {
          yield {
            delta,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            finishReason,
            usage,
          };
        }
      }
    } catch (err) {
      throw mapError(err, handle);
    } finally {
      handle.finish();
    }
  }

  /**
   * 发起请求并返回响应句柄。
   *
   * 句柄持有定时器与调用方 abort 的 relay；**流式请求**在响应头到达后即停止
   * 计时（长流由调用方 abort 控制），但 relay 必须保留到调用方消费完毕——
   * 提前移除会导致"流到一半用户点停止"无法中断底层读取。
   */
  private async send(request: ChatRequest, stream: boolean, caller?: AbortSignal): Promise<RequestHandle> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const relayAbort = () => controller.abort();
    if (caller) {
      if (caller.aborted) controller.abort();
      else caller.addEventListener('abort', relayAbort, { once: true });
    }
    const finish = () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', relayAbort);
    };
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.defaultHeaders };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const payload: Record<string, unknown> = {
        model: request.model,
        messages: toUpstreamMessages(request.messages),
        stream,
      };
      if (request.temperature !== undefined) payload.temperature = request.temperature;
      if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
      if (request.tools !== undefined && request.tools.length > 0) {
        payload.tools = request.tools;
        if (request.toolChoice !== undefined) payload.tool_choice = request.toolChoice;
      }
      if (stream && request.streamOptions?.includeUsage) payload.stream_options = { include_usage: true };
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw await toHttpError(response);
      if (stream) clearTimeout(timer);
      return { response, finish, timedOut: () => timedOut };
    } catch (err) {
      finish();
      if (err instanceof AiError) throw err;
      if (isAbortLike(err)) {
        if (timedOut) throw new AiTimeoutError(`AI request timed out after ${this.timeoutMs}ms`);
        throw new AiAbortError('AI request aborted');
      }
      throw new AiNetworkError(`AI request failed: ${errorMessage(err)}`, undefined, err);
    }
  }
}

interface RequestHandle {
  response: Response;
  /** 清理定时器与调用方 abort 监听（消费结束后调用）。 */
  finish: () => void;
  timedOut: () => boolean;
}

function mapError(err: unknown, handle: RequestHandle): AiError {
  if (err instanceof AiError) return err;
  if (isAbortLike(err)) {
    return handle.timedOut()
      ? new AiTimeoutError('AI request timed out while reading the response')
      : new AiAbortError('AI request aborted');
  }
  return new AiNetworkError(`AI request failed: ${errorMessage(err)}`, undefined, err);
}

async function toHttpError(response: Response): Promise<AiError> {
  const text = await response.text().catch(() => '');
  const status = response.status;
  if (status === 401 || status === 403) return new AiAuthError(`AI authentication failed (HTTP ${status})`);
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new AiRateLimitedError(retryAfterMs, 'AI rate limited (HTTP 429)');
  }
  if (status === 402 || status === 409) {
    return new AiQuotaExceededError(parseQuotaInfo(text), `AI quota exceeded (HTTP ${status})`);
  }
  const snippet = truncate(text, ERROR_SNIPPET_CHARS);
  return new AiNetworkError(`AI request failed (HTTP ${status})${snippet ? `: ${snippet}` : ''}`, status);
}

function extractMessage(body: unknown): Record<string, unknown> | undefined {
  const choices = (body as Record<string, unknown> | null)?.choices;
  const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
  return choice?.message as Record<string, unknown> | undefined;
}

function extractContent(body: unknown): string | undefined {
  const message = extractMessage(body);
  return typeof message?.content === 'string' ? message.content : undefined;
}

/** Serialize internal messages into the OpenAI wire shape (snake_case fields). */
function toUpstreamMessages(messages: ChatRequest['messages']): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const hasToolCalls = m.toolCalls !== undefined && m.toolCalls.length > 0;
    return {
      role: m.role,
      // Assistant tool-call messages carry no text; send null rather than "".
      content: m.role === 'assistant' && hasToolCalls && m.content === '' ? null : m.content,
      ...(hasToolCalls ? { tool_calls: m.toolCalls } : {}),
      ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
    };
  });
}

export function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const fn = (entry as Record<string, unknown>).function as Record<string, unknown> | undefined;
    const id = (entry as Record<string, unknown>).id;
    const name = fn?.name;
    const args = fn?.arguments;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    const argsText = typeof args === 'string' ? args : args === undefined ? '' : JSON.stringify(args);
    out.push({ id, type: 'function', function: { name, arguments: argsText } });
  }
  return out;
}

export function parseToolCallDeltas(raw: unknown): ToolCallDelta[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCallDelta[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const fn = e.function as Record<string, unknown> | undefined;
    const index = typeof e.index === 'number' && Number.isInteger(e.index) && e.index >= 0 ? e.index : undefined;
    if (index === undefined) continue;
    const delta: ToolCallDelta = {
      index,
      ...(typeof e.id === 'string' && e.id.length > 0 ? { id: e.id } : {}),
      ...(typeof fn?.name === 'string' && fn.name.length > 0 ? { function: { name: fn.name } } : {}),
    };
    if (typeof fn?.arguments === 'string' && fn.arguments.length > 0) {
      delta.function = { ...delta.function, arguments: fn.arguments };
    }
    out.push(delta);
  }
  return out;
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

function parseRetryAfter(header: string | null): number | undefined {
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

function parseQuotaInfo(text: string): AiQuotaInfo | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const source = (body.error && typeof body.error === 'object' ? body.error : body) as Record<string, unknown>;
    const quota: AiQuotaInfo = {};
    const limit = toFiniteNumber(source.limit);
    const used = toFiniteNumber(source.used);
    const reserved = toFiniteNumber(source.reserved);
    if (limit !== undefined) quota.limit = limit;
    if (used !== undefined) quota.used = used;
    if (reserved !== undefined) quota.reserved = reserved;
    if (typeof source.resetAt === 'string') quota.resetAt = source.resetAt;
    return Object.keys(quota).length > 0 ? quota : undefined;
  } catch {
    return undefined;
  }
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