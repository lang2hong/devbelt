import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, EmailVerificationInvalidError } from '../domain/errors.js';
import type { LinkFlowService } from '../service/linkFlowService.js';
import type { CsrfService } from '../service/csrfService.js';
import type { AuditWriter } from '../service/auditWriter.js';
import { registerConsoleErrorHandler, rejectConsole } from '../middleware/consoleError.js';
import { linkFlowCookieName, csrfCookieName, readCookie, serializeCookie } from '../middleware/cookies.js';
import { linkFlowClaimBody, resendBody } from './schemas.js';

export interface LinkFlowRouteOptions {
  linkFlowService: LinkFlowService;
  csrfService: CsrfService;
  auditWriter: AuditWriter;
  consoleOrigin: string;
  resendVerification: (emailRaw: string, ip?: string) => Promise<{ ok: true }>;
}

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function acceptsJson(req: FastifyRequest): boolean {
  const accept = headerOf(req, 'accept');
  if (!accept) return false;
  const a = accept.toLowerCase();
  return a.includes('application/json') || a.includes('*/*');
}

function isJsonContentType(req: FastifyRequest): boolean {
  const ct = headerOf(req, 'content-type');
  if (!ct) return false;
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * 一次性邮件链接公开路由（P3 §5/§6）。切片 1 只交付 verify-email + 匿名 resend。
 *
 * Origin/Accept/Content-Type/CSRF 守卫放在 preValidation（先于 schema 校验），
 * 确保 403/406/415 优先于 422，且新端点错误统一走 §6 信封（本作用域错误处理器）。
 */
export async function linkFlowRoutes(app: FastifyInstance, opts: LinkFlowRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  function requireOrigin(req: FastifyRequest): boolean {
    return headerOf(req, 'origin') === opts.consoleOrigin;
  }

  function anonymousCsrfOk(req: FastifyRequest): boolean {
    return opts.csrfService.verify(readCookie(req, csrfCookieName()), headerOf(req, 'x-csrf-token'));
  }

  const originGuard: Guard = async (req, reply) => {
    if (!requireOrigin(req)) return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
  };
  const contentTypeGuard: Guard = async (req, reply) => {
    if (!isJsonContentType(req)) return rejectConsole(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  };
  const acceptGuard: Guard = async (req, reply) => {
    if (!acceptsJson(req)) return rejectConsole(reply, 406, 'NOT_ACCEPTABLE', 'Accept must include application/json');
  };
  const csrfGuard: Guard = async (req, reply) => {
    if (!anonymousCsrfOk(req)) return rejectConsole(reply, 403, 'FORBIDDEN', 'csrf validation failed');
  };

  // 匿名认领：token possession → 签发短时 link-flow cookie（显式豁免 CSRF §5.1 L184）。
  app.post(
    '/api/public/link-flows',
    { schema: { body: linkFlowClaimBody }, preValidation: [originGuard, contentTypeGuard, acceptGuard] },
    async (req, reply) => {
      const { type, token } = req.body as { type: string; token: string };
      const existingNonce = readCookie(req, linkFlowCookieName());
      const result = await opts.linkFlowService.claim({ type, token, ip: req.ip, existingNonce });
      reply.header('Set-Cookie', serializeCookie(linkFlowCookieName(), result.nonce, { httpOnly: true, maxAgeSeconds: 600 }));
      reply.send({ ok: true });
    },
  );

  // 认领后的消费：以 link-flow cookie 定位，不接原始 token。匿名 CSRF + Origin + Accept。
  app.post(
    '/api/public/link-flows/verify-email',
    { preValidation: [originGuard, acceptGuard, csrfGuard] },
    async (req, reply) => {
      const nonce = readCookie(req, linkFlowCookieName());
      if (!nonce) {
        throw new EmailVerificationInvalidError();
      }
      try {
        const result = await opts.linkFlowService.verifyEmail(nonce);
        reply.header('Set-Cookie', serializeCookie(linkFlowCookieName(), nonce, { httpOnly: true, clear: true }));
        opts.auditWriter.write({
          eventType: 'email.verify.consumed',
          result: 'success',
          actorUserId: result.userId,
          targetType: 'email_verification_token',
          targetId: String(result.tokenId),
          sourceIp: req.ip,
          requestId: requestIdOf(req),
        });
        reply.send({ ok: true });
      } catch (e) {
        opts.auditWriter.write({
          eventType: 'email.verify.failed',
          result: 'failure',
          failureCode: e instanceof DomainError ? e.code : null,
          sourceIp: req.ip,
          requestId: requestIdOf(req),
        });
        throw e;
      }
    },
  );

  // 匿名重发（CSRF + Origin）。限流由 AuthService.resendVerification 内部执行。
  app.post(
    '/api/public/link-flows/resend-verification',
    { schema: { body: resendBody }, preValidation: [originGuard, contentTypeGuard, acceptGuard, csrfGuard] },
    async (req, reply) => {
      const { email } = req.body as { email: string };
      try {
        const result = await opts.resendVerification(email, req.ip);
        opts.auditWriter.write({
          eventType: 'email.verification.resend',
          result: 'success',
          sourceIp: req.ip,
          requestId: requestIdOf(req),
        });
        reply.send(result);
      } catch (e) {
        opts.auditWriter.write({
          eventType: 'email.verification.resend',
          result: 'failure',
          failureCode: e instanceof DomainError ? e.code : null,
          sourceIp: req.ip,
          requestId: requestIdOf(req),
        });
        throw e;
      }
    },
  );
}