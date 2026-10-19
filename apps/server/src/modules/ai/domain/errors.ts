import { DomainError } from '../../../domain/errors.js';

/**
 * AI 模块领域错误（P9 §6.8 错误码约定）。
 *
 * - 配额超限用 **409**（不是 429/402）：429 留给"请求频率"限流，402 带支付语义
 *   易与加油包混淆；409 表达"当前资源状态（剩余额度不足）无法完成请求"最贴切。
 * - 上游认证错 → 401；上游限流 → 429（带 Retry-After）；上游 5xx/网络/协议/未配置
 *   → 503。一律不透传上游原始错误体（防 Key/账号信息泄漏给客户端）。
 */

/** 月额度+加油包合计不足（限流之外的资源状态）→ 409 AI_QUOTA_EXCEEDED。 */
export class AiQuotaExceededError extends DomainError {
  constructor(
    public readonly quota: { limit: number; used: number; reserved: number; topupRemaining: number; resetAt: string },
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
/** 每用户并发 AI 请求超套餐上限（free=1 / pro=3，特性 maxAiConcurrentRequests）→ 429。 */
export class AiConcurrencyExceededError extends DomainError {
  constructor(public readonly retryAfterSeconds: number) {
    super('AI concurrency limit exceeded for your plan', 'AI_CONCURRENCY_EXCEEDED');
    this.name = 'AiConcurrencyExceededError';
  }
}

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

/** 加油包 SKU 不存在或已停用（下单用）→ 404 TOPUP_SKU_NOT_FOUND。 */
export class TopupSkuNotFoundError extends DomainError {
  constructor(public readonly skuCode: string) {
    super('topup sku not found', 'TOPUP_SKU_NOT_FOUND');
    this.name = 'TopupSkuNotFoundError';
  }
}

/** 加油包订单不存在 → 404 TOPUP_ORDER_NOT_FOUND。 */
export class TopupOrderNotFoundError extends DomainError {
  constructor(public readonly orderNo: string) {
    super('topup order not found', 'TOPUP_ORDER_NOT_FOUND');
    this.name = 'TopupOrderNotFoundError';
  }
}

/** 加油包订单状态不允许该操作（如非 fulfilled 退款、已退款入账）→ 409 TOPUP_ORDER_STATE。 */
export class TopupOrderStateError extends DomainError {
  constructor(public readonly orderNo: string, message: string) {
    super(message, 'TOPUP_ORDER_STATE');
    this.name = 'TopupOrderStateError';
  }
}