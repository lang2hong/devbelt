import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CsrfService } from '../service/csrfService.js';
import type { RateLimitService } from '../service/rateLimitService.js';
import type { ConsoleAuthService } from '../service/consoleAuthService.js';
import type { AuditWriter } from '../service/auditWriter.js';
import { DomainError } from '../domain/errors.js';
import { registerConsoleErrorHandler, rejectConsole } from '../middleware/consoleError.js';
import { csrfCookieName, refreshCookieName, linkFlowCookieName, readCookie, serializeCookie } from '../middleware/cookies.js';
import { loginBody, registerBody } from './schemas.js';

export interface ConsoleAuthRouteOptions {
  csrfService: CsrfService;
  rateLimiter: RateLimitService;
  consoleAuthService: ConsoleAuthService;
  consoleOrigin: string;
  auditWriter: AuditWriter;
  /** Refresh cookie 的 Max-Age（秒），对齐服务端 refresh token 有效期（§4.2）。 */
  refreshMaxAgeSeconds: number;
  register: (email: string, password: string, displayName?: string, ip?: string) => Promise<{ ok: true }>;
  /** 登录成功后把 link-flow cookie 绑定的 mail_flow 绑定到 userId（§5.3，best-effort）。 */
  bindMailFlow?: (nonce: string, userId: number) => Promise<void>;
}

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

function acceptsJson(req: FastifyRequest): boolean {
  const a = (headerOf(req, 'accept') ?? '').toLowerCase();
  return a.includes('application/json') || a.includes('*/*');
}

function isJsonContentType(req: FastifyRequest): boolean {
  const ct = headerOf(req, 'content-type');
  if (!ct) return false;
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * 控制台认证路由（§4.2）：匿名 CSRF bootstrap + register/login/refresh/logout。
 * login 后 CSRF 轮换为 sessionId 绑定的签名 token；refresh/logout 按 refresh cookie
 * 解析 sessionId 校验绑定。错误统一走 §6 控制台信封。
 */
export async function consoleAuthRoutes(app: FastifyInstance, opts: ConsoleAuthRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const requireOrigin = (req: FastifyRequest): boolean => headerOf(req, 'origin') === opts.consoleOrigin;

  const anonymousCsrfOk = (req: FastifyRequest): boolean =>
    opts.csrfService.verify(readCookie(req, csrfCookieName()), headerOf(req, 'x-csrf-token'));

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

  // 匿名/会话 CSRF token 签发：带有效 web refresh cookie 时签发绑定到该 family 的 token，
  // 否则签发匿名 token（login/register/mail-flow 用）。见 §4.2 规则 3。
  app.get('/api/console/auth/csrf', async (req, reply) => {
    await opts.rateLimiter.hit(`console:csrf:ip:${req.ip ?? 'unknown'}`, 60, 120);
    const refreshToken = readCookie(req, refreshCookieName());
    let binding: string | undefined;
    if (refreshToken) {
      binding = await opts.consoleAuthService.sessionIdOf(refreshToken);
    }
    const token = opts.csrfService.issue(binding);
    reply.header('Set-Cookie', serializeCookie(csrfCookieName(), token, { httpOnly: false, maxAgeSeconds: 3600 }));
    reply.code(204).send();
  });

  app.post(
    '/api/console/auth/register',
    { schema: { body: registerBody }, preValidation: [originGuard, contentTypeGuard, acceptGuard, csrfGuard] },
    async (req, reply) => {
      const { email, password, displayName } = req.body as { email: string; password: string; displayName?: string };
      await opts.register(email, password, displayName, req.ip);
      reply.code(201).send({ ok: true, requiresEmailVerification: true });
    },
  );

  app.post(
    '/api/console/auth/login',
    { schema: { body: loginBody }, preValidation: [originGuard, contentTypeGuard, acceptGuard, csrfGuard] },
    async (req, reply) => {
      const { email, password, deviceKey } = req.body as { email: string; password: string; deviceKey: string };
      try {
        const result = await opts.consoleAuthService.login(email, password, deviceKey, req.ip);
        reply.header('Set-Cookie', serializeCookie(refreshCookieName(), result.refreshToken, { httpOnly: true, maxAgeSeconds: opts.refreshMaxAgeSeconds }));
        reply.header('Set-Cookie', serializeCookie(csrfCookieName(), opts.csrfService.issue(result.familyId), { httpOnly: false, maxAgeSeconds: 3600 }));
        opts.auditWriter.write({ eventType: 'auth.login.success', result: 'success', actorUserId: Number(result.user.userId), sourceIp: req.ip, requestId: requestIdOf(req) });
        // 登录成功后把未登录阶段认领的 mail_flow 绑定到当前用户（accept-invitation 交接）。
        // best-effort：绑定失败不阻断登录；消费端点会再次校验归属。
        const nonce = readCookie(req, linkFlowCookieName());
        if (nonce && opts.bindMailFlow) {
          await opts.bindMailFlow(nonce, Number(result.user.userId)).catch(() => {});
        }
        reply.send({ accessToken: result.accessToken, user: result.user });
      } catch (e) {
        opts.auditWriter.write({ eventType: 'auth.login.failed', result: 'failure', failureCode: e instanceof DomainError ? e.code : null, sourceIp: req.ip, requestId: requestIdOf(req) });
        throw e;
      }
    },
  );

  app.post(
    '/api/console/auth/refresh',
    { preValidation: [originGuard, acceptGuard] },
    async (req, reply) => {
      const refreshToken = readCookie(req, refreshCookieName());
      if (!refreshToken) return rejectConsole(reply, 401, 'UNAUTHORIZED', 'unauthorized');

      const sessionId = await opts.consoleAuthService.sessionIdOf(refreshToken);
      if (!sessionId) return rejectConsole(reply, 401, 'UNAUTHORIZED', 'unauthorized');
      if (!opts.csrfService.verify(readCookie(req, csrfCookieName()), headerOf(req, 'x-csrf-token'), sessionId)) {
        return rejectConsole(reply, 403, 'FORBIDDEN', 'csrf validation failed');
      }
      await opts.rateLimiter.hit(`console:refresh:${sessionId}`, 60, 30);

      try {
        const result = await opts.consoleAuthService.refresh(refreshToken);
        reply.header('Set-Cookie', serializeCookie(refreshCookieName(), result.refreshToken, { httpOnly: true, maxAgeSeconds: opts.refreshMaxAgeSeconds }));
        reply.send({ accessToken: result.accessToken });
      } catch (e) {
        reply.header('Set-Cookie', serializeCookie(refreshCookieName(), '', { httpOnly: true, clear: true }));
        throw e;
      }
    },
  );

  app.post(
    '/api/console/auth/logout',
    { preValidation: [originGuard, acceptGuard] },
    async (req, reply) => {
      const refreshToken = readCookie(req, refreshCookieName());
      if (refreshToken) {
        const sessionId = await opts.consoleAuthService.sessionIdOf(refreshToken);
        if (sessionId && !opts.csrfService.verify(readCookie(req, csrfCookieName()), headerOf(req, 'x-csrf-token'), sessionId)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'csrf validation failed');
        }
        if (sessionId) await opts.rateLimiter.hit(`console:logout:${sessionId}`, 60, 10);
        await opts.consoleAuthService.logout(refreshToken);
      }
      reply.header('Set-Cookie', serializeCookie(refreshCookieName(), '', { httpOnly: true, clear: true }));
      reply.header('Set-Cookie', serializeCookie(csrfCookieName(), '', { httpOnly: false, clear: true }));
      opts.auditWriter.write({ eventType: 'auth.logout', result: 'success', sourceIp: req.ip, requestId: requestIdOf(req) });
      reply.send({ ok: true });
    },
  );
}