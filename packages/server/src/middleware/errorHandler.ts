import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DomainError,
  RateLimitedError,
  IdempotencyInProgressError,
  ResourceVersionConflictError,
  SyncEpochStaleError,
  SyncVersionConflictError,
  SyncQuotaExceededError,
  SubscriptionVersionConflictError,
  SyncResetInProgressError,
} from '../domain/errors.js';

/** 构造 DomainError 的标准响应体；版本/配额/epoch 冲突附带对应上下文字段。 */
function domainErrorBody(e: DomainError): Record<string, unknown> {
  const body: Record<string, unknown> = { message: e.message, code: e.code };
  if (e instanceof ResourceVersionConflictError) body.currentVersion = e.currentVersion;
  if (e instanceof SubscriptionVersionConflictError) body.currentVersion = e.currentVersion;
  if (e instanceof SyncVersionConflictError) body.currentVersion = e.currentVersion;
  if (e instanceof SyncEpochStaleError) body.currentKeyEpoch = e.currentKeyEpoch;
  if (e instanceof SyncQuotaExceededError) {
    body.quota = e.quota;
    body.limit = e.limit;
    body.used = e.used;
  }
  return body;
}

/**
 * 统一错误响应：只处理 DomainError（按 code 映射 HTTP 状态）。
 *
 * 非 DomainError 一律**重新抛出**，交给全局 errorHandler ——
 * 那里才会 `req.log.error` 记录堆栈与请求上下文。若在此直接回 500，
 * 未知异常就永久丢失了诊断信息（只剩一条无上下文的 500 响应）。
 */
export function sendError(reply: FastifyReply, e: unknown): void {
  if (!(e instanceof DomainError)) throw e;
  if (e instanceof RateLimitedError) {
    reply.header('Retry-After', e.retryAfterSeconds);
  }
  if (e instanceof IdempotencyInProgressError) {
    reply.header('Retry-After', e.retryAfterSeconds);
  }
  if (e instanceof SyncResetInProgressError) {
    reply.header('Retry-After', e.retryAfterSeconds);
  }
  reply.code(errorStatus(e.code)).send(domainErrorBody(e));
}

/**
 * 注册全局错误处理器（安全网，兜住漏写 try/catch 的 handler）。
 *
 * - schema 校验失败 → 400 VALIDATION_FAILED（与规格 §8 统一错误码一致）
 * - DomainError → 按 code 映射
 * - 429（DomainError 之外的限流源）→ 保留 Retry-After
 * - 其余 4xx 保留状态码但不透传内部细节；未处理异常只进日志，回 500 固定文案
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (err.validation) {
      reply.code(400).send({ message: 'validation failed', code: 'VALIDATION_FAILED' });
      return;
    }

    if (err instanceof DomainError) {
      if (err instanceof RateLimitedError) reply.header('Retry-After', err.retryAfterSeconds);
      if (err instanceof IdempotencyInProgressError) reply.header('Retry-After', err.retryAfterSeconds);
      if (err instanceof SyncResetInProgressError) reply.header('Retry-After', err.retryAfterSeconds);
      reply.code(errorStatus(err.code)).send(domainErrorBody(err));
      return;
    }

    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status === 429) {
      reply.code(429).send({ message: 'too many requests', code: 'TOO_MANY_REQUESTS' });
      return;
    }
    if (status >= 400 && status < 500) {
      reply.code(status).send({ message: 'Bad request', code: 'VALIDATION_FAILED' });
      return;
    }

    req.log.error({ err, url: req.url, method: req.method }, 'unhandled route error');
    reply.code(500).send({ message: 'Internal server error' });
  });

  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({ message: 'not found', code: 'NOT_FOUND' });
  });
}

/**
 * 领域错误码 → HTTP 状态码映射（全量，见实施规格 §8）。
 * 未在此表中的 code 一律 400（新增 code 需先在规格冻结后再补映射）。
 */
export function errorStatus(code: string): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'USER_DISABLED':
    case 'PERSONAL_FEATURE_REQUIRED':
    case 'FORBIDDEN':
    case 'ORGANIZATION_FEATURE_REQUIRED':
      return 403;
    case 'SYNC_SIGNATURE_INVALID':
      return 403;
    case 'TOKEN_AUDIENCE_FORBIDDEN':
      return 403;
    case 'ORGANIZATION_NOT_FOUND':
    case 'NOT_FOUND':
    case 'RESOURCE_NOT_FOUND':
      return 404;
    case 'ORGANIZATION_QUOTA_EXCEEDED':
    case 'RESOURCE_VERSION_CONFLICT':
    case 'SUBSCRIPTION_VERSION_CONFLICT':
    case 'FOLDER_NOT_EMPTY':
    case 'FOLDER_MOVE_CYCLE':
    case 'ORGANIZATION_ADMIN_REQUIRED':
    case 'CONFLICT':
      return 409;
    case 'SYNC_STATE_EXISTS':
    case 'SYNC_EPOCH_STALE':
    case 'SYNC_VERSION_CONFLICT':
    case 'SYNC_NONCE_REUSED':
    case 'SYNC_QUOTA_EXCEEDED':
    case 'SYNC_RESET_HANDOFF_REUSED':
    case 'SYNC_RESET_IN_PROGRESS':
      return 409;
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'IDEMPOTENCY_IN_PROGRESS':
      return 409;
    case 'RESOURCE_CONTENT_INVALID':
    case 'INVITATION_INVALID':
    case 'LINK_FLOW_INVALID':
    case 'INVITATION_TARGET_NOT_ELIGIBLE':
    case 'VALIDATION_FAILED':
      return 400;
    case 'SYNC_NOT_INITIALIZED':
    case 'SYNC_PROTOCOL_UNSUPPORTED':
    case 'SYNC_RESET_HANDOFF_INVALID':
      return 400;
    case 'EMAIL_VERIFICATION_INVALID':
      return 401;
    case 'EMAIL_VERIFICATION_ALREADY_CONFIRMED':
      return 409;
    case 'TOO_MANY_REQUESTS':
      return 429;
    default:
      return 400;
  }
}