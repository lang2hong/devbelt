import type { FastifyInstance } from 'fastify';
import type { CsrfService } from '../service/csrfService.js';
import type { RateLimitService } from '../service/rateLimitService.js';
import { registerConsoleErrorHandler } from '../middleware/consoleError.js';
import { csrfCookieName, serializeCookie } from '../middleware/cookies.js';

export interface ConsoleAuthRouteOptions {
  csrfService: CsrfService;
  rateLimiter: RateLimitService;
}

/**
 * 控制台认证路由（切片 1 仅匿名 CSRF bootstrap；login/refresh/logout 见切片 2）。
 */
export async function consoleAuthRoutes(app: FastifyInstance, opts: ConsoleAuthRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // 匿名 CSRF token 签发：非 HttpOnly cookie，前端回显到 X-CSRF-Token 头。
  app.get('/api/console/auth/csrf', async (req, reply) => {
    await opts.rateLimiter.hit(`console:csrf:ip:${req.ip ?? 'unknown'}`, 60, 120);
    const token = opts.csrfService.issue();
    reply.header('Set-Cookie', serializeCookie(csrfCookieName(), token, { httpOnly: false, maxAgeSeconds: 3600 }));
    reply.code(204).send();
  });
}