/**
 * 领域错误基类：携带 code 供路由层映射 HTTP 状态码。
 *
 * code 全集见 docs/v3/实施规格.md §5「统一错误」。本切片只实现会用到的错误类，
 * 但 errorStatus 映射表会覆盖已冻结的全部 code，后续切片无需改动映射结构。
 */
export class DomainError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 请求体结构 / 长度 / 枚举 / 空白校验失败 → 400 */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_FAILED');
    this.name = 'ValidationError';
  }
}

/** 未认证或凭据无效 → 401。未知邮箱、错密码、未验证邮箱、被禁用统一此码。 */
export class UnauthorizedError extends DomainError {
  constructor(message = 'unauthorized') {
    super(message, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

/** 用户被禁用 → 403 USER_DISABLED */
export class UserDisabledError extends DomainError {
  constructor(public readonly userId: number) {
    super('user disabled', 'USER_DISABLED');
    this.name = 'UserDisabledError';
  }
}

/**
 * 个人权益不足（如设备数超限）→ 403 PERSONAL_FEATURE_REQUIRED。
 * 与后续切片的 ORGANIZATION_FEATURE_REQUIRED / FORBIDDEN 语义分离。
 */
export class PersonalFeatureRequiredError extends DomainError {
  constructor(public readonly feature: string) {
    super(`${feature} exceeds the personal Free entitlement`, 'PERSONAL_FEATURE_REQUIRED');
    this.name = 'PersonalFeatureRequiredError';
  }
}

/** 限流触发 → 429 TOO_MANY_REQUESTS */
export class RateLimitedError extends DomainError {
  constructor(public readonly retryAfterSeconds: number) {
    super('too many requests', 'TOO_MANY_REQUESTS');
    this.name = 'RateLimitedError';
  }
}

/** 实体 / 资源未找到 → 404 */
export class EntityNotFoundError extends DomainError {
  constructor(entity: string, id: string | number) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND');
    this.name = 'EntityNotFoundError';
  }
}

/** 资源已存在（并发冲突）→ 409 */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

/**
 * 组织不存在 / closed / 调用者非 active member → 统一 404（§5：不区分，防枚举）。
 */
export class OrganizationNotFoundError extends DomainError {
  constructor() {
    super('organization not found', 'ORGANIZATION_NOT_FOUND');
    this.name = 'OrganizationNotFoundError';
  }
}

/** 操作会导致最后一个 active admin 消失 → 409 ORGANIZATION_ADMIN_REQUIRED（§3）。 */
export class OrganizationAdminRequiredError extends DomainError {
  constructor() {
    super('at least one active admin is required', 'ORGANIZATION_ADMIN_REQUIRED');
    this.name = 'OrganizationAdminRequiredError';
  }
}

/** 已认证但对目标资源无权操作 → 403 FORBIDDEN。 */
export class ForbiddenError extends DomainError {
  constructor(message = 'forbidden') {
    super(message, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

/** 邀请 token 无效 / 已消费 / 已撤销 / 已过期 / 邮箱不匹配 / 组织已关闭 → 400 INVITATION_INVALID。 */
export class InvitationInvalidError extends DomainError {
  constructor(message = 'invitation invalid') {
    super(message, 'INVITATION_INVALID');
    this.name = 'InvitationInvalidError';
  }
}

/** 邀请目标不满足前置条件（未注册 / 未验证 / 已是成员）→ 400 INVITATION_TARGET_NOT_ELIGIBLE。 */
export class InvitationTargetNotEligibleError extends DomainError {
  constructor(message = 'invitation target not eligible') {
    super(message, 'INVITATION_TARGET_NOT_ELIGIBLE');
    this.name = 'InvitationTargetNotEligibleError';
  }
}

/** 组织容量（seat_limit）已满 → 409 ORGANIZATION_QUOTA_EXCEEDED（§4.3）。 */
export class OrganizationQuotaExceededError extends DomainError {
  constructor() {
    super('organization seat quota exceeded', 'ORGANIZATION_QUOTA_EXCEEDED');
    this.name = 'OrganizationQuotaExceededError';
  }
}