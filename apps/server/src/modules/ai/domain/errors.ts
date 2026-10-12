import { DomainError } from '../../../domain/errors.js';

/**
 * AI 模块领域错误（P9 §6.8 错误码约定）。
 *
 * - 配额超限用 **409**（不是 429/402）：429 留给"请求频率"限流，402 带支付语义
 *   易与加油包混淆；409 表达"当前资源状态（剩余额度不足）无法完成请求"最贴切。
 * - 上游认证错 → 401；上游限流 → 429（带 Retry-After）；上游 5xx/网络/协议/未配置
 *   → 503。一律不透传上游原始错误体（防 Key/账号信息泄漏给客户端）。
 */

/** 月额度不足（限流之外的资源状态）→ 409 AI_QUOTA_EXCEEDED。 */
export class AiQuotaExceededError extends DomainError {
  constructor(
    public readonly quota: { limit: number; used: number; reserved: number; resetAt: string },
  ) {
    super('AI monthly token quota exceeded', 'AI_QUOTA_EXCEEDED');
    this.name = 'AiQuotaExceededError';
  }
}

/** 上游 AI 认证失败（部署侧 Key 配置问题）→ 401 AI_PROVIDER_AUTH_ERROR。 */
export class AiProviderAuthError extends DomainError {
  constructor() {
    super('AI provider authentication failed', 'AI_PROVIDER_AUTH_ERROR');
    this.name = 'AiProviderAuthError';
  }
}

/** 上游 AI 限流 → 429 AI_RATE_LIMITED（按上游 Retry-After 或 60s 默认值）。 */
export class AiProviderRateLimitedError extends DomainError {
  constructor(public readonly retryAfterSeconds: number) {
    super('AI provider rate limited', 'AI_RATE_LIMITED');
    this.name = 'AiProviderRateLimitedError';
  }
}

/** 上游 AI 故障（5xx/网络/协议/未配置）→ 503 AI_PROVIDER_ERROR。 */
export class AiProviderError extends DomainError {
  constructor(message = 'AI provider error') {
    super(message, 'AI_PROVIDER_ERROR');
    this.name = 'AiProviderError';
  }
}