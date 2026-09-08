import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CsrfService } from '../service/csrfService.js';
import { csrfCookieName, refreshCookieName, readCookie, serializeCookie } from './cookies.js';

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function sessionIdOf(req: FastifyRequest): string | undefined {
  return (req as unknown as { authSessionId?: string }).authSessionId;
}

function audienceOf(req: FastifyRequest): string | undefined {
  return (req as unknown as { authAudience?: string }).authAudience;
}

/**
 * 带宽需求：console audience 的写请求须通过 Origin 同源 + 会话绑定 CSRF；
 * 纯 Bearer 的扩展 audience 天然无 CSRF 风险，跳过（§4.2 规则 1/4）。
 */
export function isConsoleAudience(req: FastifyRequest): boolean {
  return audienceOf(req) === 'console';
}

/** 控制台写请求的 Origin + 会话绑定 CSRF 校验（仅对 console audience 生效）。 */
export function consoleWriteGuard(req: FastifyRequest, csrfService: CsrfService, consoleOrigin: string): boolean {
  if (!isConsoleAudience(req)) return true;
  if (headerOf(req, 'origin') !== consoleOrigin) return false;
  const sessionId = sessionIdOf(req);
  if (!sessionId) return false;
  return csrfService.verify(readCookie(req, csrfCookieName()), headerOf(req, 'x-csrf-token'), sessionId);
}

/** 清空 refresh + csrf cookie（登出/改密/撤销当前会话/禁用等，§4.2 L131）。 */
export function clearSessionCookies(reply: FastifyReply): void {
  reply.header('Set-Cookie', [
    serializeCookie(refreshCookieName(), '', { httpOnly: true, clear: true }),
    serializeCookie(csrfCookieName(), '', { httpOnly: false, clear: true }),
  ]);
}