import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError } from '../domain/errors.js';

/** 统一错误响应：DomainError 按 code 映射 HTTP 状态，其他默认 500 */
export function sendError(reply: FastifyReply, e: unknown): void {
  if (e instanceof DomainError) {
    reply.code(errorStatus(e.code)).send({ message: (e as Error).message, code: (e as DomainError).code });
  } else {
    reply.code(500).send({ message: 'Internal server error' });
  }
}

/**
 * 注册全局错误处理器。
 *
 * `sendError` 是逐 handler 手工调用的，漏写 try/catch 的端点（曾有 10 个：
 * auth 的 sessions + admin 的 9 个列表端点）会落到 Fastify 默认处理器，
 * 响应体带 `err.message` —— mysql2 的 `sqlMessage` 会连同插值后的 SQL
 * 一起回显给客户端。典型触发：`GET /admin/users?limit=abc` 生成
 * `LIMIT NaN`，MySQL 语法错原文外泄。
 *
 * 这里兜住三类：
 *  1. schema 校验失败（err.validation）→ 400，结构与 DomainError 一致
 *  2. DomainError → 按 code 映射
 *  3. 其余 → 500 固定文案，原始错误只进服务端日志
 *
 * 注意：不改既有 handler 里的 sendError 调用。那些是显式的、语义更精确的
 * 处理，全局 handler 只是安全网。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // Fastify schema 校验失败：err.validation 是校验器给的明细数组
    if (err.validation) {
      reply.code(400).send({
        message: `request validation failed: ${err.message}`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    if (err instanceof DomainError) {
      reply.code(errorStatus(err.code)).send({ message: err.message, code: err.code });
      return;
    }

    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;

    /**
     * 429 必须在通用 4xx 分支之前处理。
     *
     * `@fastify/rate-limit` 是 `throw errorResponseBuilder(...)`（源码 index.js:375），
     * 抛出的 Error 带 `statusCode: 429`，所以会落到下面的 4xx 分支被改写成
     * 'Bad request' —— 客户端就拿不到「多久后可重试」了。状态码和 retry-after
     * 响应头不受影响（头在 throw 之前就 set 好了），但正文里的等待时长会丢。
     *
     * 这里的 message 是插件自己生成的固定文案，不含任何内部信息，可以放行。
     */
    if (status === 429) {
      reply.code(429).send({ message: err.message, code: err.code ?? 'RATE_LIMITED' });
      return;
    }

    // Fastify 自身抛的 4xx（如 body 不是合法 JSON、415、请求体超限）保留其状态码，
    // 但不透传 message —— 那里可能带解析器细节。
    if (status >= 400 && status < 500) {
      reply.code(status).send({ message: 'Bad request', code: err.code ?? 'BAD_REQUEST' });
      return;
    }

    req.log.error({ err, url: req.url, method: req.method }, 'unhandled route error');
    reply.code(500).send({ message: 'Internal server error' });
  });

  // 404 也统一结构（默认处理器会回显 `Route GET:/x not found`，泄漏路由探测信息）
  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({ message: 'not found', code: 'NOT_FOUND' });
  });
}

/** 领域错误码 → HTTP 状态码映射 */
export function errorStatus(code: string): number {
  switch (code) {
    case 'INVALID_CREDENTIALS':
    case 'TOKEN_REUSE':
      return 401;
    case 'USER_DISABLED':
    case 'DEVICE_LIMIT_EXCEEDED':
    case 'PRO_FEATURE_REQUIRED':
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
