import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, RateLimitedError } from '../domain/errors.js';

/** 统一错误响应：DomainError 按 code 映射 HTTP 状态，其他默认 500。 */
export function sendError(reply: FastifyReply, e: unknown): void {
  if (e instanceof DomainError) {
    if (e instanceof RateLimitedError) {
      reply.header('Retry-After', e.retryAfterSeconds);
    }
    reply.code(errorStatus(e.code)).send({ message: e.message, code: e.code });
  } else {
    reply.code(500).send({ message: 'Internal server error' });
  }
}

/**
 * 注册全局错误处理器（安全网，兜住漏写 try/catch 的 handler）。
 *
 * - schema 校验失败 → 400 VALIDATION_FAILED（与规格 §5 统一错误码一致）
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
      reply.code(errorStatus(err.code)).send({ message: err.message, code: err.code });
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
 * 领域错误码 → HTTP 状态码映射（全量，见实施规格 §5 统一错误）。
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
    case 'ORGANIZATION_NOT_FOUND':
    case 'NOT_FOUND':
    case 'RESOURCE_NOT_FOUND':
      return 404;
    case 'ORGANIZATION_QUOTA_EXCEEDED':
    case 'RESOURCE_VERSION_CONFLICT':
    case 'FOLDER_NOT_EMPTY':
    case 'FOLDER_MOVE_CYCLE':
    case 'ORGANIZATION_ADMIN_REQUIRED':
    case 'CONFLICT':
      return 409;
    case 'RESOURCE_CONTENT_INVALID':
    case 'INVITATION_INVALID':
    case 'INVITATION_TARGET_NOT_ELIGIBLE':
    case 'VALIDATION_FAILED':
      return 400;
    case 'TOO_MANY_REQUESTS':
      return 429;
    default:
      return 400;
  }
}