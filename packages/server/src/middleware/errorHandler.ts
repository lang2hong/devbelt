import type { FastifyReply } from 'fastify';
import { DomainError } from '../domain/errors.js';

/** 统一错误响应：DomainError 按 code 映射 HTTP 状态，其他默认 400 */
export function sendError(reply: FastifyReply, e: unknown): void {
  if (e instanceof DomainError) {
    reply.code(errorStatus(e.code)).send({ message: (e as Error).message, code: (e as DomainError).code });
  } else {
    reply.code(400).send({ message: (e as Error).message });
  }
}

/** 领域错误码 → HTTP 状态码映射 */
export function errorStatus(code: string): number {
  switch (code) {
    case 'INVALID_CREDENTIALS':
    case 'TOKEN_REUSE':
      return 401;
    case 'USER_DISABLED':
    case 'DEVICE_LIMIT_EXCEEDED':
    case 'SUBSCRIPTION_EXPIRED':
    case 'QUOTA_EXCEEDED':
      return 403;
    case 'NOT_FOUND':
    case 'VERSION_NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    default:
      return 400;
  }
}
