/**
 * 领域错误基类：携带 code 供路由层映射 HTTP 状态码。
 *
 * code 全集见各 route service；errorStatus 映射表集中维护 HTTP 状态。
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
 * 与 ORGANIZATION_FEATURE_REQUIRED / FORBIDDEN 语义分离。
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
 * 组织不存在 / closed / 调用者非 active member → 统一 404（§6.1：不区分，防枚举）。
 */
export class OrganizationNotFoundError extends DomainError {
  constructor() {
    super('organization not found', 'ORGANIZATION_NOT_FOUND');
    this.name = 'OrganizationNotFoundError';
  }
}

/** 操作会导致最后一个 active admin 消失 → 409 ORGANIZATION_ADMIN_REQUIRED（§6.1）。 */
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

/** 组织容量（seat / 资源数量 / 字节）已满 → 409 ORGANIZATION_QUOTA_EXCEEDED（§4.2/§6.2）。 */
export class OrganizationQuotaExceededError extends DomainError {
  constructor(message = 'organization quota exceeded') {
    super(message, 'ORGANIZATION_QUOTA_EXCEEDED');
    this.name = 'OrganizationQuotaExceededError';
  }
}

/** 组织资源不存在 / 软删除 / 跨组织 → 404 RESOURCE_NOT_FOUND（§8）。 */
export class ResourceNotFoundError extends DomainError {
  constructor() {
    super('resource not found', 'RESOURCE_NOT_FOUND');
    this.name = 'ResourceNotFoundError';
  }
}

/** 资源内容违反 4.4 节闭合 schema → 400 RESOURCE_CONTENT_INVALID。 */
export class ResourceContentInvalidError extends DomainError {
  constructor(message = 'resource content invalid') {
    super(message, 'RESOURCE_CONTENT_INVALID');
    this.name = 'ResourceContentInvalidError';
  }
}

/** 不允许的模板引擎（超出订阅快照白名单）→ 403 ORGANIZATION_FEATURE_REQUIRED。 */
export class OrganizationFeatureRequiredError extends DomainError {
  constructor(message = 'organization feature required') {
    super(message, 'ORGANIZATION_FEATURE_REQUIRED');
    this.name = 'OrganizationFeatureRequiredError';
  }
}

/** 乐观锁版本冲突 → 409 RESOURCE_VERSION_CONFLICT（响应带 currentVersion）。 */
export class ResourceVersionConflictError extends DomainError {
  constructor(public readonly currentVersion: number) {
    super('resource version conflict', 'RESOURCE_VERSION_CONFLICT');
    this.name = 'ResourceVersionConflictError';
  }
}

/** 目录非空（含未删除子目录或资源）不可删除 → 409 FOLDER_NOT_EMPTY。 */
export class FolderNotEmptyError extends DomainError {
  constructor() {
    super('folder not empty', 'FOLDER_NOT_EMPTY');
    this.name = 'FolderNotEmptyError';
  }
}

/** 目录移动成环（parentId=自身或新父为其后代）→ 409 FOLDER_MOVE_CYCLE。 */
export class FolderMoveCycleError extends DomainError {
  constructor() {
    super('folder move would create a cycle', 'FOLDER_MOVE_CYCLE');
    this.name = 'FolderMoveCycleError';
  }
}

// ── 个人 E2E 同步（§8 同步错误）──

/** 无 active sync state 的读写（与从未注册同形）→ 400 SYNC_NOT_INITIALIZED。 */
export class SyncNotInitializedError extends DomainError {
  constructor() { super('sync not initialized', 'SYNC_NOT_INITIALIZED'); this.name = 'SyncNotInitializedError'; }
}

/** record 不存在（同一 epoch 下从未创建）→ 404 NOT_FOUND（§8：错误体不出现 recordId）。 */
export class SyncRecordNotFoundError extends DomainError {
  constructor() { super('record not found', 'NOT_FOUND'); this.name = 'SyncRecordNotFoundError'; }
}

/** 请求 protocol/cipher/format 不在支持集 → 400 SYNC_PROTOCOL_UNSUPPORTED。 */
export class SyncProtocolUnsupportedError extends DomainError {
  constructor(message = 'sync protocol unsupported') { super(message, 'SYNC_PROTOCOL_UNSUPPORTED'); this.name = 'SyncProtocolUnsupportedError'; }
}

/** 签名验证失败（未证明持钥=无权）→ 403 SYNC_SIGNATURE_INVALID。 */
export class SyncSignatureInvalidError extends DomainError {
  constructor() { super('sync signature invalid', 'SYNC_SIGNATURE_INVALID'); this.name = 'SyncSignatureInvalidError'; }
}

/** 重复 init → 409 SYNC_STATE_EXISTS。 */
export class SyncStateExistsError extends DomainError {
  constructor() { super('sync state already exists', 'SYNC_STATE_EXISTS'); this.name = 'SyncStateExistsError'; }
}

/** 请求 keyEpoch ≠ active keyEpoch → 409 SYNC_EPOCH_STALE（附 currentKeyEpoch）。 */
export class SyncEpochStaleError extends DomainError {
  constructor(public readonly currentKeyEpoch: string) { super('sync epoch stale', 'SYNC_EPOCH_STALE'); this.name = 'SyncEpochStaleError'; }
}

/** baseVersion/expectedStateVersion 与当前不一致（乐观锁）→ 409 SYNC_VERSION_CONFLICT（附 currentVersion）。 */
export class SyncVersionConflictError extends DomainError {
  constructor(public readonly currentVersion: string) { super('sync version conflict', 'SYNC_VERSION_CONFLICT'); this.name = 'SyncVersionConflictError'; }
}

/** (user_id,key_epoch) 下 nonce 复用 → 409 SYNC_NONCE_REUSED。 */
export class SyncNonceReusedError extends DomainError {
  constructor() { super('sync nonce reused', 'SYNC_NONCE_REUSED'); this.name = 'SyncNonceReusedError'; }
}

/** count/bytes 配额超限 → 409 SYNC_QUOTA_EXCEEDED（附 quota/limit/used）。 */
export class SyncQuotaExceededError extends DomainError {
  constructor(public readonly quota: 'count' | 'bytes', public readonly limit: string, public readonly used: string) {
    super('sync quota exceeded', 'SYNC_QUOTA_EXCEEDED');
    this.name = 'SyncQuotaExceededError';
  }
}

// ── 一次性邮件链接（mail-flow）──

/** 邮箱验证 token 已被消费（邮箱已验）→ 409 EMAIL_VERIFICATION_ALREADY_CONFIRMED。 */
export class EmailVerificationAlreadyConfirmedError extends DomainError {
  constructor() {
    super('email verification already confirmed', 'EMAIL_VERIFICATION_ALREADY_CONFIRMED');
    this.name = 'EmailVerificationAlreadyConfirmedError';
  }
}

/** 邮件流失效/过期/撤销/不存在，或验证 token 无效/过期 → 401 EMAIL_VERIFICATION_INVALID。 */
export class EmailVerificationInvalidError extends DomainError {
  constructor() {
    super('invalid or expired verification link', 'EMAIL_VERIFICATION_INVALID');
    this.name = 'EmailVerificationInvalidError';
  }
}

/** access token 的 aud 不匹配当前端点 → 403 TOKEN_AUDIENCE_FORBIDDEN（§4.1）。 */
export class TokenAudienceForbiddenError extends DomainError {
  constructor() {
    super('token audience not allowed here', 'TOKEN_AUDIENCE_FORBIDDEN');
    this.name = 'TokenAudienceForbiddenError';
  }
}
