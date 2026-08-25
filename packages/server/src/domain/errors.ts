/** 领域错误基类：携带 code 供路由层映射 HTTP 状态码 */
export class DomainError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 配额超限（带配额名/上限/当前值） */
export class QuotaExceededError extends DomainError {
  constructor(
    public readonly quota: string,
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(`${quota} quota exceeded: ${current}/${limit}`, 'QUOTA_EXCEEDED');
    this.name = 'QuotaExceededError';
  }
}

/** 设备数超限 */
export class DeviceLimitError extends DomainError {
  constructor(public readonly limit: number, public readonly current: number) {
    super(`device limit exceeded: ${current}/${limit}`, 'DEVICE_LIMIT_EXCEEDED');
    this.name = 'DeviceLimitError';
  }
}

/** Refresh token 重用检测（已撤销的 refresh 被使用 → 全撤销） */
export class TokenReuseError extends DomainError {
  constructor(public readonly tokenId: number, public readonly userId: number) {
    super('refresh token reuse detected', 'TOKEN_REUSE');
    this.name = 'TokenReuseError';
  }
}

/** 订阅已过期 */
export class SubscriptionExpiredError extends DomainError {
  constructor(public readonly userId: number) {
    super('subscription expired', 'SUBSCRIPTION_EXPIRED');
    this.name = 'SubscriptionExpiredError';
  }
}

/** 实体未找到 */
export class EntityNotFoundError extends DomainError {
  constructor(entity: string, id: string | number) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND');
    this.name = 'EntityNotFoundError';
  }
}

/** 凭据无效 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('invalid credentials', 'INVALID_CREDENTIALS');
    this.name = 'InvalidCredentialsError';
  }
}

/** 用户被禁用 */
export class UserDisabledError extends DomainError {
  constructor(public readonly userId: number) {
    super('user disabled', 'USER_DISABLED');
    this.name = 'UserDisabledError';
  }
}

/** 回滚目标版本不存在 */
export class VersionNotFoundError extends DomainError {
  constructor(public readonly userId: number, public readonly section: string, public readonly version: number) {
    super(`version ${version} not found for section ${section}`, 'VERSION_NOT_FOUND');
    this.name = 'VersionNotFoundError';
  }
}

/** 同步冲突：客户端 baseVersion 与服务端 currentVersion 不一致 */
export class ConflictError extends DomainError {
  constructor(public readonly current: number, public readonly base: number) {
    super(`sync conflict: base=${base}, current=${current}`, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

/** 请求参数校验失败 */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

/** 付费功能（free 套餐不可用，需升级 Pro） */
export class ProFeatureRequiredError extends DomainError {
  constructor(public readonly feature: string) {
    super(`${feature} requires a paid plan`, 'PRO_FEATURE_REQUIRED');
    this.name = 'ProFeatureRequiredError';
  }
}
