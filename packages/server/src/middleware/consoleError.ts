import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, RateLimitedError, IdempotencyInProgressError } from '../domain/errors.js';
import { errorStatus } from './errorHandler.js';

/**
 * 控制台/公开 API 统一错误契约（P3 §6）。
 *
 * 错误关联 id 仅通过响应头 `X-Request-ID` 提供（全局 requestId 中间件），不写入错误
 * body（§6 L232）。此次错误信封为 `{ error: { code, message } }`。
 *
 * `VALIDATION_FAILED` 在控制台/公开 API 上映射为 422（而非共享扩展 API 的 400）——
 * 二者错误语义分离：扩展 `/api/*` 保持 400 平铺，新 `/api/public/*`、`/api/console/*`
 * 走 422 信封。
 */
export function consoleErrorStatus(code: string): number {
  return code === 'VALIDATION_FAILED' ? 422 : errorStatus(code);
}

/**
 * 控制台/公开 API 作用域错误处理器：覆盖 schema 校验失败、DomainError、JSON 解析失败、
 * 415/429、未知 4xx 与意外 5xx，全部落到 §6 信封。仅在对应插件作用域内注册。
 */
export function registerConsoleErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const e = err as FastifyErrorLike;

    // Fastify schema 校验失败 → 422 VALIDATION_FAILED。
    if (e && e.validation) {
      reply.code(422).send({ error: { code: 'VALIDATION_FAILED', message: 'validation failed' } });
      return;
    }

    if (err instanceof DomainError) {
      if (err instanceof RateLimitedError) reply.header('Retry-After', String(err.retryAfterSeconds));
      if (err instanceof IdempotencyInProgressError) reply.header('Retry-After', String(err.retryAfterSeconds));
      reply.code(consoleErrorStatus(err.code)).send({ error: { code: err.code, message: err.message } });
      return;
    }

    const status = e && typeof e.statusCode === 'number' ? e.statusCode : 500;
    if (status === 415) {
      reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } });
      return;
    }
    if (status === 406) {
      reply.code(406).send({ error: { code: 'NOT_ACCEPTABLE', message: 'Accept must include application/json' } });
      return;
    }
    if (status === 429) {
      reply.header('Retry-After', String((e && (e as { retryAfterSeconds?: number }).retryAfterSeconds) ?? 60));
      reply.code(429).send({ error: { code: 'TOO_MANY_REQUESTS', message: 'too many requests' } });
      return;
    }
    // JSON 解析失败等其他 4xx：统一按客户端错误处理，不透传内部细节。
    if (status >= 400 && status < 500) {
      reply.code(status).send({ error: { code: 'VALIDATION_FAILED', message: 'Bad request' } });
      return;
    }

    req.log?.error?.({ err }, 'unhandled console route error');
    reply.code(500).send({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } });
  });
}

/** 请求级守卫（Origin/CSRF/Content-Type/Accept）失败时的统一信封响应；返回 reply 供钩子短路。 */
export function rejectConsole(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

interface FastifyErrorLike {
  validation?: unknown;
  statusCode?: number;
  code?: string;
  retryAfterSeconds?: number;
}