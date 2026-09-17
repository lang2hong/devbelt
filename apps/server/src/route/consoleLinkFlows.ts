import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { consoleSession, type GetAuthUser } from '../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../middleware/consoleError.js';
import { consoleWriteGuard } from '../middleware/consoleWrite.js';
import { linkFlowCookieName, readCookie, serializeCookie } from '../middleware/cookies.js';
import type { LinkFlowService, AcceptInvitationOrganization } from '../service/linkFlowService.js';
import { DomainError, InvitationInvalidError, LinkFlowInvalidError, SyncResetHandoffInvalidError } from '../domain/errors.js';
import type { TokenService } from '../service/tokenService.js';
import type { CsrfService } from '../service/csrfService.js';
import type { AuditWriter } from '../service/auditWriter.js';
import type { RateLimitService } from '../service/rateLimitService.js';

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

/** 控制台邮件流消费接口（§5.3）：接受组织邀请。仅凭 mail_flow 记录（非路径 token）作为凭据。 */
export async function consoleLinkFlowRoutes(app: FastifyInstance, opts: ConsoleLinkFlowRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      // 显式绑定（§5.3）：已登录用户点击邀请链接、绕过了「登录时绑定」场景时，
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

      child.post('/api/console/link-flows/accept-invitation', async (req, reply) => {
        // 控制台写：Origin 同源 + 会话绑定 CSRF（§4.2）。
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        }

        const userId = authUserIdOf(req);
        const sessionId = sessionIdOf(req);
        await opts.rateLimiter.hit(`console:accept-invitation:${sessionId ?? userId}`, 600, 5);

        const nonce = readCookie(req, linkFlowCookieName());
        if (!nonce) {
          opts.auditWriter.write({
            eventType: 'invitation.accept',
            result: 'failure',
            failureCode: 'INVITATION_INVALID',
            actorUserId: userId,
            sourceIp: req.ip,
            requestId: requestIdOf(req),
          });
          return rejectConsole(reply, 400, 'INVITATION_INVALID', 'invitation invalid');
        }

        try {
          const result = await opts.linkFlowService.acceptInvitation(nonce, userId);
          clearLinkFlowCookie(reply);
          const organization = serializeOrg(result.organization);
          opts.auditWriter.write({
            eventType: 'invitation.accept',
            result: 'success',
            actorUserId: userId,
            targetType: 'organization',
            targetId: String(result.organization.organizationId),
            organizationId: result.organization.organizationId,
            sourceIp: req.ip,
            requestId: requestIdOf(req),
          });
          if (result.kind === 'accepted') {
            return reply.send({ organization });
          }
          return reply
            .code(409)
            .send({ error: { code: 'INVITATION_ALREADY_ACCEPTED', message: 'invitation already accepted' }, organization });
        } catch (e) {
          // 仅业务终态（INVITATION_INVALID）清 Cookie；未知异常/5xx 保留 Cookie，
          // 使浏览器可在 10 分钟有效期内重试（§5.3）。
          const terminal = e instanceof InvitationInvalidError;
          if (terminal) clearLinkFlowCookie(reply);
          opts.auditWriter.write({
            eventType: 'invitation.accept',
            result: 'failure',
            failureCode: e instanceof DomainError ? e.code : null,
            actorUserId: userId,
            sourceIp: req.ip,
            requestId: requestIdOf(req),
          });
          if (terminal) {
            return rejectConsole(reply, 400, 'INVITATION_INVALID', 'invitation invalid');
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

function serializeOrg(o: AcceptInvitationOrganization) {
  return {
    organizationId: String(o.organizationId),
    name: o.name,
    status: o.status,
    closedTime: o.closedTime ? o.closedTime.toISOString() : null,
    role: o.role,
  };
}