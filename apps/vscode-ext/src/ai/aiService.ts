import * as vscode from 'vscode';
import {
  OpenAICompatibleProvider,
  estimateTokens,
  type AiFeature,
  type AiProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
} from '@devbelt/ai-core';
import { maxAiTokensMonthly, type CachedEntitlement } from '@devbelt/db-host/sync/entitlementGate';
import { AiKeyStore } from './aiKeyStore.js';
import { AiLoginRequiredError, AiNotConfiguredError } from './aiErrors.js';
import { ServerProxyProvider, type AiUsageSnapshot } from './serverProxyProvider.js';
import type { AuditLogger } from '../utils/auditLogger.js';

export type AiProviderMode = 'server-proxy' | 'openai-compatible';

/** 面板/服务读取的 AI 配置快照（devbelt.ai.* 设置的归一化视图）。 */
export interface AiConfig {
  provider: AiProviderMode;
  baseUrl: string;
  model: string;
  includeColumnComments: boolean;
  temperature: number;
  /** schema 注入模式（S4）：current-db 默认；recent-only 暂按 current-db 行为；off 不注入。 */
  schemaContextMode: 'current-db' | 'recent-only' | 'off';
  /** 数据问答样本行数（S4）：默认 10，上限 50。 */
  dataSampleRows: number;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_SAMPLE_ROWS = 10;
const MAX_SAMPLE_ROWS = 50;

export function readAiConfig(): AiConfig {
  const config = vscode.workspace.getConfiguration('devbelt');
  const temperature = config.get<number>('ai.temperature', DEFAULT_TEMPERATURE);
  const rawMode = config.get<string>('ai.schemaContextMode');
  const sampleRows = config.get<number>('ai.dataSampleRows', DEFAULT_SAMPLE_ROWS);
  return {
    provider: config.get<string>('ai.provider') === 'openai-compatible' ? 'openai-compatible' : 'server-proxy',
    baseUrl: (config.get<string>('ai.baseUrl') ?? '').trim(),
    model: (config.get<string>('ai.model') ?? '').trim(),
    includeColumnComments: config.get<boolean>('ai.includeColumnComments', true),
    temperature:
      typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
        ? temperature
        : DEFAULT_TEMPERATURE,
    schemaContextMode:
      rawMode === 'off' || rawMode === 'recent-only' ? rawMode : 'current-db',
    dataSampleRows:
      typeof sampleRows === 'number' && Number.isFinite(sampleRows)
        ? Math.min(MAX_SAMPLE_ROWS, Math.max(1, Math.floor(sampleRows)))
        : DEFAULT_SAMPLE_ROWS,
  };
}

/** AiService 依赖的最小认证面（AuthService 结构性满足；测试可注入 fake）。 */
export interface AiAuthLike {
  isLoggedIn(): boolean;
  getAccessToken(): string | undefined;
  getCachedEntitlement(): CachedEntitlement | undefined;
  /** 401 时静默续期（SyncClient 单飞刷新）；缺省则不重试，直接报授权错误。 */
  refreshAccessToken?: () => Promise<string | undefined>;
}

export interface AiServiceOptions {
  keyStore: AiKeyStore;
  auth: AiAuthLike;
  serverUrl: string;
  getConfig?: () => AiConfig;
  audit?: AuditLogger;
  /** 测试注入；生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 可中止的流：`abort()` 由面板停止按钮/关闭面板触发。 */
export interface AiMutableStream<T> extends AsyncIterable<T> {
  abort(): void;
}

/** provider 可用性（面板初始化/状态条展示）。 */
export interface AiProviderStatus {
  mode: AiProviderMode;
  model: string;
  baseUrl: string;
  available: boolean;
  reason?: 'login-required' | 'api-key-missing' | 'not-configured';
}

/** 请求附加上下文（审计元数据；不含 prompt/回复明文）。 */
export interface AiRequestMeta {
  feature: AiFeature;
  connName?: string;
  database?: string;
}

/**
 * 客户端 AI 服务（P9 S3）：双 provider 路由、流式 + abort、审计、配额查询。
 *
 * - `server-proxy`（默认）：登录后走 `/api/ai/chat`（access token 每请求动态读取）；
 * - `openai-compatible`：读设置 baseUrl/model + SecretStorage apiKey，直连上游；
 * - Quota 预检为**展示性**：额度快照来自 `GET /api/ai/usage`（或 entitlement），
 *   硬拦截以服务端 409 为准，客户端估算不承担闸门职责。
 */
export class AiService {
  private readonly getConfig: () => AiConfig;
  private readonly audit?: AuditLogger;
  private readonly fetchImpl?: typeof fetch;

  constructor(private readonly opts: AiServiceOptions) {
    this.getConfig = opts.getConfig ?? readAiConfig;
    this.audit = opts.audit;
    this.fetchImpl = opts.fetchImpl;
  }

  /** 当前 provider 可用性（不抛错；UI 据此显示"去登录/去设置"提示）。 */
  async describeProvider(): Promise<AiProviderStatus> {
    const config = this.getConfig();
    const status: AiProviderStatus = {
      mode: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      available: true,
    };
    if (config.provider === 'server-proxy') {
      if (!this.opts.auth.isLoggedIn()) {
        status.available = false;
        status.reason = 'login-required';
      }
      return status;
    }
    if (!config.baseUrl || !config.model) {
      status.available = false;
      status.reason = 'not-configured';
      return status;
    }
    if (!(await this.opts.keyStore.hasApiKey())) {
      status.available = false;
      status.reason = 'api-key-missing';
    }
    return status;
  }

  /**
   * 流式对话。每请求独立 AbortController（禁止共享——对齐 P8 N2 教训）。
   * 审计在流结束/失败/中止后写一条元数据（feature/connName/latency），不含明文。
   */
  streamChat(request: ChatRequest, meta: AiRequestMeta): AiMutableStream<ChatStreamChunk> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const service = this;
    const iterator = (async function* (): AsyncGenerator<ChatStreamChunk> {
      try {
        const provider = await service.pickProvider();
        for await (const chunk of provider.chatStream(request, controller.signal)) {
          yield chunk;
        }
        service.writeAudit(meta, Date.now() - startedAt);
      } catch (err) {
        service.writeAudit(meta, Date.now() - startedAt);
        throw err;
      }
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      abort: () => controller.abort(),
    };
  }

  /** 非流式对话（聚合流式结果；用于 Inline 补全等短请求）。支持外部 AbortSignal。 */
  async chat(request: ChatRequest, meta: AiRequestMeta, signal?: AbortSignal): Promise<ChatResponse> {
    const startedAt = Date.now();
    try {
      const provider = await this.pickProvider();
      const result = await provider.chat(request, signal);
      this.writeAudit(meta, Date.now() - startedAt);
      return result;
    } catch (err) {
      this.writeAudit(meta, Date.now() - startedAt);
      throw err;
    }
  }

  /** 本月额度快照（仅 server-proxy 模式；未登录/失败返回 undefined）。 */
  async fetchUsage(): Promise<AiUsageSnapshot | undefined> {
    if (this.getConfig().provider !== 'server-proxy') return undefined;
    if (!this.opts.auth.isLoggedIn()) return undefined;
    const provider = new ServerProxyProvider({
      serverUrl: this.opts.serverUrl,
      getAccessToken: () => this.opts.auth.getAccessToken(),
      ...(this.opts.auth.refreshAccessToken ? { onAuthFailure: () => this.opts.auth.refreshAccessToken!() } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    return provider.getUsage();
  }

  /** 客户端展示性额度上限（entitlement 派生，fail-closed 0）。 */
  quotaLimit(): number {
    return maxAiTokensMonthly(this.opts.auth.getCachedEntitlement());
  }

  /** 展示性 prompt tokens 估算（CJK/英文粗估；硬校验以服务端 usage 为准）。 */
  static estimatePromptTokens(messages: ReadonlyArray<{ content: string }>): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  private async pickProvider(): Promise<AiProvider> {
    const config = this.getConfig();
    if (config.provider === 'openai-compatible') {
      if (!config.baseUrl || !config.model) {
        throw new AiNotConfiguredError('AI baseUrl/model is not configured');
      }
      const apiKey = await this.opts.keyStore.getApiKey();
      if (!apiKey) throw new AiNotConfiguredError('AI apiKey is not configured');
      return new OpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
    }
    if (!this.opts.auth.isLoggedIn()) throw new AiLoginRequiredError();
    return new ServerProxyProvider({
      serverUrl: this.opts.serverUrl,
      getAccessToken: () => this.opts.auth.getAccessToken(),
      ...(this.opts.auth.refreshAccessToken ? { onAuthFailure: () => this.opts.auth.refreshAccessToken!() } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }

  /** 审计为旁路（不含 prompt/回复明文）；只记动作/连接/耗时。 */
  private writeAudit(meta: AiRequestMeta, latencyMs: number): void {
    this.audit?.log({
      action: 'ai_chat',
      connName: meta.connName ?? 'AI Chat',
      ...(meta.database ? { database: meta.database } : {}),
      costTime: latencyMs,
    });
  }
}