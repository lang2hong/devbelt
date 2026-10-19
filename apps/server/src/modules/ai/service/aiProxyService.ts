import type { ServerResponse } from 'node:http';
import { estimateTokens, type TokenUsage } from '@devbelt/ai-core';
import { AiBillingService, billingTokens, costCents, type EffectiveUpstream } from './aiBillingService.js';
import { AiConcurrencyExceededError } from '../domain/errors.js';
import { parseSse } from '@devbelt/ai-core/sse';
import { DomainError, ValidationError } from '../../../domain/errors.js';
import { errorStatus } from '../../../middleware/errorHandler.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import {
  AiProviderAuthError,
  AiProviderError,
  AiProviderRateLimitedError,
} from '../domain/errors.js';
import type { AiQuotaService, AiReservation } from './aiQuotaService.js';
import type { AiUpstreamConfig } from '../aiConfig.js';

/** 服务端 completion 上限（与 §6.5 schema 3-4K 预算对齐；客户端请求超过则收敛到此值）。 */
export const MAX_COMPLETION_TOKENS = 512;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 120_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
const AUDIT_REASON_CHARS = 500;

const AI_FEATURES = [
  'chat',
  'nl2sql',
  'explain',
  'optimize',
  'error-diagnose',
  'data-qa',
  'schema-design',
  'inline-completion',
] as const;
export type AiFeatureName = (typeof AI_FEATURES)[number];

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 校验并归一化后的代理请求（model/stream/stream_options 由服务端强制，不透传）。 */
export interface ValidatedChatRequest {
  messages: AiChatMessage[];
  temperature?: number;
  /** 已收敛到 [1, MAX_COMPLETION_TOKENS]。 */
  maxTokens: number;
  feature: AiFeatureName;
}

export interface AiProxyOptions {
  config: AiUpstreamConfig;
  quota: AiQuotaService;
  audit: AuditWriter;
  log: (msg: string, data?: unknown) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * 计费引擎（管理后台可配置；可选注入）：模型/上游连接/统一 token 权重/调整系数均以
   * billing 的生效配置为准（60s 缓存），env config 仅为缺省回退。计费口径：
   * 计费 token = (输入 + 输出 × k) × 系数；预占与结算同口径。
   */
  billing?: AiBillingService;
}

export interface AiForwardArgs {
  userId: number;
  body: ValidatedChatRequest;
  reservation: AiReservation;
  /** 已 hijack 的原始响应（`res.on('close')` 用于客户端断开时 abort 上游）。 */
  res: ServerResponse;
  requestId?: string;
}

/**
 * 服务端代理（parse-and-forward，P9 §6.8）。
 *
 * 不复用逐字节透明 pipe：pipe 无法同时拦截 SSE 内部带 usage 的 finish chunk。
 * 用 `@devbelt/ai-core/sse` 的 `parseSse` 逐事件解析上游流：
 * - 解析成功的事件**原样转发**（语义一致；不重新序列化，避免键序/空白差异）；
 * - 单 chunk JSON.parse 失败：审计 warn + 原样转发 + 继续（不中断已下发的流）；
 * - 强制 `stream_options.include_usage=true`，拦截 finish usage 做权威计量；
 * - 客户端断开立即 abort 上游（不继续计费）；
 * - finish/error/abort 都走 finally 结算（单段月额度）。
 */
export class AiProxyService {
  /** 每用户在途请求计数（并发闸门，013）。 */
  private readonly inflight = new Map<number, number>();

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AiProxyOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : UPSTREAM_TIMEOUT_MS;
  }

  /** 请求体校验（400）；不检查上游配置（配置缺失在 begin 才 503）。 */
  validate(raw: unknown): ValidatedChatRequest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('request body must be a JSON object');
    }
    const body = raw as Record<string, unknown>;

    const rawMessages = body.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      throw new ValidationError('messages must be a non-empty array');
    }
    if (rawMessages.length > MAX_MESSAGES) {
      throw new ValidationError(`messages must contain at most ${MAX_MESSAGES} entries`);
    }
    let totalChars = 0;
    const messages: AiChatMessage[] = rawMessages.map((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ValidationError(`messages[${i}] must be an object`);
      }
      const { role, content } = entry as Record<string, unknown>;
      if (role !== 'system' && role !== 'user' && role !== 'assistant') {
        throw new ValidationError(`messages[${i}].role must be system|user|assistant`);
      }
      if (typeof content !== 'string' || content.length === 0) {
        throw new ValidationError(`messages[${i}].content must be a non-empty string`);
      }
      if (content.length > MAX_MESSAGE_CHARS) {
        throw new ValidationError(`messages[${i}].content exceeds ${MAX_MESSAGE_CHARS} characters`);
      }
      totalChars += content.length;
      return { role, content };
    });
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new ValidationError(`messages total length exceeds ${MAX_TOTAL_CHARS} characters`);
    }

    let temperature: number | undefined;
    if (body.temperature !== undefined) {
      if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
        throw new ValidationError('temperature must be a number in [0, 2]');
      }
      temperature = body.temperature;
    }

    let maxTokens = MAX_COMPLETION_TOKENS;
    if (body.maxTokens !== undefined) {
      if (typeof body.maxTokens !== 'number' || !Number.isFinite(body.maxTokens)) {
        throw new ValidationError('maxTokens must be a finite number');
      }
      maxTokens = Math.min(Math.max(1, Math.floor(body.maxTokens)), MAX_COMPLETION_TOKENS);
    }

    let feature: AiFeatureName = 'chat';
    if (body.feature !== undefined) {
      if (typeof body.feature !== 'string' || !(AI_FEATURES as readonly string[]).includes(body.feature)) {
        throw new ValidationError(`feature must be one of: ${AI_FEATURES.join(', ')}`);
      }
      feature = body.feature as AiFeatureName;
    }

    return { messages, temperature, maxTokens, feature };
  }

  /**
   * 请求开始：确认上游已配置 + 预占额度。超限抛 `AiQuotaExceededError`（409），
   * 此时尚未写任何响应头，由路由转成 JSON 错误。
   */
  async begin(userId: number, body: ValidatedChatRequest): Promise<AiReservation> {
    // 并发闸门（013）：按套餐特性 maxAiConcurrentRequests 限制在途请求数（free=1 / pro=3）。
    // 槽位在 forward 的结算段 finally 释放（含 abort/失败路径）；进程内计数，重启自愈。
    const concurrencyLimit = await this.opts.quota.resolveConcurrencyLimit(userId);
    const inFlight = this.inflight.get(userId) ?? 0;
    if (inFlight >= concurrencyLimit) throw new AiConcurrencyExceededError(5);
    this.inflight.set(userId, inFlight + 1);
    try {
      return await this.beginWithSlot(userId, body);
    } catch (err) {
      this.releaseSlot(userId);
      throw err;
    }
  }

  private async beginWithSlot(userId: number, body: ValidatedChatRequest): Promise<AiReservation> {
    const upstream = await this.effectiveUpstream();
    this.assertConfigured(upstream);
    const estimatedPromptTokens = estimatePromptTokens(body.messages);
    // 预占按计费 token：prompt × 系数；输出上限 × k × 系数（与结算同口径，并发保护不失效）。
    const weighted = billingTokens(estimatedPromptTokens, body.maxTokens, upstream.weight, upstream.multiplier);
    return this.opts.quota.reserve(userId, {
      estimatedPromptTokens: weighted.prompt,
      maxCompletionTokens: weighted.completion,
    });
  }

  /**
   * 转发上游 SSE 到客户端。调用前响应必须已 hijack；本方法负责全部响应写出一句
   * 不向调用方抛错（预流错误写 JSON、流中错误写 SSE error 事件），并始终结算额度 + 审计。
   */
  async forward(args: AiForwardArgs): Promise<void> {
    const { userId, body, reservation, res, requestId } = args;
    const startedAt = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    let headersTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let upstreamAccepted = false;
    let usage: TokenUsage | undefined;
    let estimatedCompletionTokens = 0;
    let clientAborted = false;
    let streamSettled = false;
    let failure: DomainError | undefined;

    const onClientClose = (): void => {
      if (streamSettled) return;
      clientAborted = true;
      controller.abort();
    };
    res.on('close', onClientClose);

    try {
      const upstream = await this.effectiveUpstream();
      const response = await this.fetchImpl(`${upstream.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.upstreamHeaders(upstream),
        body: JSON.stringify(this.upstreamPayload(body, upstream)),
        signal: controller.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response);
      upstreamAccepted = true;
      if (headersTimer) {
        clearTimeout(headersTimer);
        headersTimer = undefined;
      }
      if (!response.body) throw new AiProviderError('AI upstream returned an empty streaming response');
      if (res.destroyed) {
        clientAborted = true;
        streamSettled = true;
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        // hijack 后 Fastify 之前 set 的头不会自动应用，手动回显请求链路 id。
        ...(requestId ? { 'X-Request-ID': requestId } : {}),
      });

      for await (const event of parseSse(response.body)) {
        if (controller.signal.aborted) {
          clientAborted = true;
          break;
        }
        if (event.data === '[DONE]') break;

        // 解析仅用于计量；无论解析成败，原始事件都原样转发（语义一致）。
        try {
          const parsed = JSON.parse(event.data) as Record<string, unknown>;
          const chunkUsage = mapUsage(parsed.usage);
          if (chunkUsage) usage = chunkUsage;
          const delta = extractDelta(parsed);
          if (delta) estimatedCompletionTokens += estimateTokens(delta);
        } catch {
          this.opts.audit.write({
            eventType: 'ai.sse.chunk_parse_failed',
            result: 'failure',
            actorUserId: userId,
            targetType: 'ai',
            requestId: requestId ?? null,
            reason: `bytes=${event.data.length}`,
          });
          this.opts.log('ai sse chunk parse failed', { bytes: event.data.length });
        }

        if (res.destroyed || res.writableEnded) {
          clientAborted = true;
          controller.abort();
          break;
        }
        res.write(`data: ${event.data}\n\n`);
      }

      streamSettled = true;
      if (!res.writableEnded && !res.destroyed) res.end('data: [DONE]\n\n');
    } catch (err) {
      if (clientAborted || (controller.signal.aborted && !timedOut && !upstreamAccepted)) {
        // 客户端断开（含未及响应即断）：不写响应、不计失败。
        clientAborted = true;
        streamSettled = true;
      } else {
        failure = toProviderDomainError(err, timedOut);
        if (!res.headersSent) {
          this.writePreStreamError(res, failure, requestId);
        } else if (!res.writableEnded && !res.destroyed) {
          res.write(
            `data: ${JSON.stringify({ error: { code: failure.code, message: 'AI stream interrupted' } })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
        }
        streamSettled = true;
      }
    } finally {
      if (headersTimer) clearTimeout(headersTimer);
      res.off('close', onClientClose);

      // 原始 token（权威 usage 优先；缺省回退估算）→ 计费 token（× k × 系数，预占同口径）。
      const raw = upstreamAccepted
        ? {
            promptTokens:
              usage && usage.promptTokens > 0 ? usage.promptTokens : reservation.estimatedPromptTokens,
            completionTokens: usage ? usage.completionTokens : estimatedCompletionTokens,
          }
        : { promptTokens: 0, completionTokens: 0 };
      const usageEstimated = upstreamAccepted && usage === undefined;
      // 输出/输入比告警（013）：> 2 记日志 + 审计标记（不阻断、不改计费）。
      const outputRatioExceeded = raw.promptTokens > 0 && raw.completionTokens / raw.promptTokens > 2;
      if (outputRatioExceeded) {
        this.opts.log('ai output ratio exceeded', { userId, promptTokens: raw.promptTokens, completionTokens: raw.completionTokens });
      }
      const upstreamConf = await this.effectiveUpstream();
      const weighted = billingTokens(raw.promptTokens, raw.completionTokens, upstreamConf.weight, upstreamConf.multiplier);
      const charge = { prompt: weighted.prompt, completion: weighted.completion };

      try {
        await this.opts.quota.settle(
          reservation,
          { promptTokens: charge.prompt, completionTokens: charge.completion },
          {
            model: upstreamConf.model,
            requestId: requestId ?? null,
            rawPromptTokens: raw.promptTokens,
            rawCompletionTokens: raw.completionTokens,
            weight: upstreamConf.weight,
            multiplier: upstreamConf.multiplier,
            costCents: costCents(raw.promptTokens, raw.completionTokens, upstreamConf.pricing),
            status: clientAborted ? 'aborted' : failure ? 'failed' : 'completed',
            usageEstimated,
            latencyMs: Date.now() - startedAt,
            ...(outputRatioExceeded ? { outputRatioExceeded: true } : {}),
          },
        );
      } catch (err) {
        // 响应已发出；结算失败只告警（额度可能滞留预占，运维可见）。
        this.opts.log('ai quota settle failed', { userId, err: String(err) });
      } finally {
        // 无论结算成败都释放并发槽位（含 abort/失败路径——本段在 forward 的 finally 内）。
        this.releaseSlot(userId);
      }

      const meta = {
        provider: 'server-proxy',
        model: upstreamConf.model,
        feature: body.feature,
        // 原始 token 与计费口径分列：审计可对账“统一 token”折算过程。
        promptTokens: raw.promptTokens,
        completionTokens: raw.completionTokens,
        billingPromptTokens: weighted.prompt,
        billingCompletionTokens: weighted.completion,
        billingWeight: upstreamConf.weight,
        billingMultiplier: upstreamConf.multiplier,
        costCents: costCents(raw.promptTokens, raw.completionTokens, upstreamConf.pricing),
        latencyMs: Date.now() - startedAt,
        usageEstimated,
      };
      if (failure || clientAborted) {
        this.opts.audit.write({
          eventType: clientAborted ? 'ai.chat.aborted' : 'ai.chat.failed',
          result: 'failure',
          failureCode: clientAborted ? 'AI_ABORTED' : failure?.code ?? null,
          actorUserId: userId,
          targetType: 'ai',
          requestId: requestId ?? null,
          reason: truncateReason(meta),
        });
      } else {
        this.opts.audit.write({
          eventType: 'ai.chat.completed',
          result: 'success',
          actorUserId: userId,
          targetType: 'ai',
          requestId: requestId ?? null,
          reason: truncateReason(meta),
        });
      }
    }
  }

  /** 生效上游（计费引擎优先；未注入/未配置回退 env）。 */
  private async effectiveUpstream(): Promise<EffectiveUpstream> {
    if (this.opts.billing) return this.opts.billing.upstream();
    return {
      configured: this.opts.config.configured,
      model: this.opts.config.model,
      baseUrl: this.opts.config.baseUrl,
      ...(this.opts.config.apiKey ? { apiKey: this.opts.config.apiKey } : {}),
      weight: 1,
      multiplier: 1,
      pricing: null,
    };
  }

  private releaseSlot(userId: number): void {
    const cur = this.inflight.get(userId) ?? 0;
    if (cur <= 1) this.inflight.delete(userId);
    else this.inflight.set(userId, cur - 1);
  }

  private assertConfigured(upstream: EffectiveUpstream): void {
    if (!upstream.configured || !upstream.baseUrl) {
      throw new AiProviderError('AI upstream is not configured');
    }
  }

  private upstreamHeaders(upstream: EffectiveUpstream): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (upstream.apiKey) headers.Authorization = `Bearer ${upstream.apiKey}`;
    return headers;
  }

  private upstreamPayload(body: ValidatedChatRequest, upstream: EffectiveUpstream): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: upstream.model,
      messages: body.messages,
      stream: true,
      // 强制携带：否则 OpenAI/DashScope 流式默认不返回 usage，无法对账。
      stream_options: { include_usage: true },
      max_tokens: body.maxTokens,
    };
    if (body.temperature !== undefined) payload.temperature = body.temperature;
    return payload;
  }

  /** 尚未写响应头时的领域错误 → 原始 JSON（响应已 hijack，不能用 reply.send）。 */
  private writePreStreamError(res: ServerResponse, err: DomainError, requestId?: string): void {
    if (res.destroyed) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (requestId) headers['X-Request-ID'] = requestId;
    if (err instanceof AiProviderRateLimitedError) {
      headers['Retry-After'] = String(err.retryAfterSeconds);
    }
    res.writeHead(errorStatus(err.code), headers);
    res.end(JSON.stringify({ message: err.message, code: err.code }));
  }
}

/** prompt 估算：CJK 1 字符 ≈ 1 token、其余 4 字符 ≈ 1 token + 每消息/整体少量结构开销。 */
export function estimatePromptTokens(messages: readonly AiChatMessage[]): number {
  const content = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  return content + messages.length * 4 + 16;
}

async function mapUpstreamHttpError(response: Response): Promise<DomainError> {
  const status = response.status;
  if (status === 401 || status === 403) return new AiProviderAuthError();
  if (status === 429) {
    return new AiProviderRateLimitedError(parseRetryAfterSeconds(response.headers.get('retry-after')));
  }
  // 不读取/透传上游响应体（可能含账号信息/Key 片段），只保留状态码。
  return new AiProviderError(`AI upstream failed (HTTP ${status})`);
}

function toProviderDomainError(err: unknown, timedOut: boolean): DomainError {
  if (err instanceof DomainError) return err;
  if (timedOut) return new AiProviderError('AI upstream timed out');
  return new AiProviderError('AI upstream request failed');
}

function extractDelta(parsed: Record<string, unknown>): string | undefined {
  const choices = parsed.choices;
  const choice = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  return typeof delta?.content === 'string' && delta.content.length > 0 ? delta.content : undefined;
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

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseRetryAfterSeconds(header: string | null): number {
  if (!header) return 60;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.round(seconds));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  return 60;
}

function truncateReason(meta: Record<string, unknown>): string {
  const json = JSON.stringify(meta);
  return json.length > AUDIT_REASON_CHARS ? `${json.slice(0, AUDIT_REASON_CHARS - 1)}…` : json;
}