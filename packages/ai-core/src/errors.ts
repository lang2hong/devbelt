/** AI 错误基类：`code` 供 UI/审计做稳定分支，不依赖 message 文本。 */
export class AiError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.cause = cause;
  }
}

export class AiAuthError extends AiError {
  constructor(message = 'AI authentication failed') {
    super('AI_AUTH_ERROR', message);
  }
}

export class AiRateLimitedError extends AiError {
  constructor(
    readonly retryAfterMs?: number,
    message = 'AI rate limited',
  ) {
    super('AI_RATE_LIMITED', message);
  }
}

export interface AiQuotaInfo {
  limit?: number;
  used?: number;
  reserved?: number;
  resetAt?: string;
}

export class AiQuotaExceededError extends AiError {
  constructor(
    readonly quota?: AiQuotaInfo,
    message = 'AI quota exceeded',
  ) {
    super('AI_QUOTA_EXCEEDED', message);
  }
}

/** 传输失败或上游非 2xx（auth/rate-limit/quota 特例之外的统一兜底）。 */
export class AiNetworkError extends AiError {
  constructor(message: string, readonly status?: number, cause?: unknown) {
    super('AI_NETWORK_ERROR', message, cause);
  }
}

export class AiTimeoutError extends AiError {
  constructor(message = 'AI request timed out') {
    super('AI_TIMEOUT', message);
  }
}

export class AiAbortError extends AiError {
  constructor(message = 'AI request aborted') {
    super('AI_ABORTED', message);
  }
}

export class AiProtocolError extends AiError {
  constructor(message = 'AI protocol error', cause?: unknown) {
    super('AI_PROTOCOL_ERROR', message, cause);
  }
}