import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { consoleSession, type GetAuthUser } from '../../../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../../../middleware/consoleError.js';
import { consoleWriteGuard } from '../../../middleware/consoleWrite.js';
import { linkFlowCookieName, readCookie, serializeCookie } from '../../../middleware/cookies.js';
import type { LinkFlowService } from '../service/linkFlowService.js';
import { LinkFlowInvalidError, SyncResetHandoffInvalidError } from '../../../domain/errors.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { CsrfService } from '../../../service/csrfService.js';
import type { AuditWriter } from '../../../service/auditWriter.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';

export interface ConsoleLinkFlowRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  linkFlowService: LinkFlowService;
  csrfService: CsrfService;
  auditWriter: AuditWriter;
  rateLimiter: RateLimitService;
  consoleOrigin: string;
  createSyncResetHandoff: (nonce: string, userId: number) => Promise<{ openUri: string; expiresTime: string }>;
}

function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

function authUserIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}

function sessionIdOf(req: FastifyRequest): string | undefined {
  return (req as unknown as { authSessionId?: string }).authSessionId;
}

/** 控制台邮件流消费接口（§5.3/§5.4）：绑定 mail-flow、签发同步重置 handoff。 */
export async function consoleLinkFlowRoutes(app: FastifyInstance, opts: ConsoleLinkFlowRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      // 显式绑定（§5.3）：已登录用户点击一次性链接、绕过了「登录时绑定」场景时，
      // 页面必须在消费前先调用此受会话保护 + Origin + session-bound CSRF 的接口，
      // 把 held mail-flow 绑定到当前用户。绑定失败保持 Cookie（业务终态除外）。
      child.post('/api/console/link-flows/bind', async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        }
        const userId = authUserIdOf(req);
        const sessionId = sessionIdOf(req);
        await opts.rateLimiter.hit(`console:linkflow-bind:${sessionId ?? userId}`, 60, 10);

        const nonce = readCookie(req, linkFlowCookieName());
        if (!nonce) {
          return rejectConsole(reply, 400, 'LINK_FLOW_INVALID', 'link flow invalid');
        }
        try {
          await opts.linkFlowService.bindFlowToUser(nonce, userId);
          return reply.send({ ok: true });
        } catch (e) {
          if (e instanceof LinkFlowInvalidError) {
            clearLinkFlowCookie(reply);
            return rejectConsole(reply, 400, 'LINK_FLOW_INVALID', 'link flow invalid');
          }
          throw e;
        }
      });

      // 同步重置两阶段交接（§5.4）：已登录用户凭 mail_flow Cookie nonce 签发
      // 扩展 handoff ticket。一次性操作（消费 mail_flow），重试依赖已签发 ticket。
      child.post('/api/console/link-flows/create-sync-reset-handoff', async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        }

        const userId = authUserIdOf(req);
        const sessionId = sessionIdOf(req);
        // 每 session 3/15min、每用户 3/h（§5.4）。
        await opts.rateLimiter.hit(`console:sync-reset-handoff:${sessionId ?? userId}`, 900, 3);
        await opts.rateLimiter.hit(`console:sync-reset-handoff:user:${userId}`, 3600, 3);

        const nonce = readCookie(req, linkFlowCookieName());
        if (!nonce) {
          clearLinkFlowCookie(reply);
          opts.auditWriter.write({
            eventType: 'sync.reset.handoff.failed',
            result: 'failure',
            failureCode: 'SYNC_RESET_HANDOFF_INVALID',
            actorUserId: userId,
            sourceIp: req.ip,
            requestId: requestIdOf(req),
          });
          return rejectConsole(reply, 400, 'SYNC_RESET_HANDOFF_INVALID', 'sync reset handoff invalid');
        }

        try {
          const result = await opts.createSyncResetHandoff(nonce, userId);
          return reply.send({ openUri: result.openUri, expiresTime: result.expiresTime });
        } catch (e) {
          // 业务终态清 Cookie；未知异常保留 Cookie（§5.4 重试依赖 ticket，非终态不重签）。
          if (e instanceof SyncResetHandoffInvalidError) clearLinkFlowCookie(reply);
          if (e instanceof SyncResetHandoffInvalidError) {
            return rejectConsole(reply, 400, 'SYNC_RESET_HANDOFF_INVALID', 'sync reset handoff invalid');
          }
          throw e;
        }
      });
    },
  });
}

function clearLinkFlowCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', serializeCookie(linkFlowCookieName(), '', { httpOnly: true, clear: true }));
}