import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consoleSession } from '../middleware/requireAuth.js';
import { registerConsoleErrorHandler, rejectConsole } from '../middleware/consoleError.js';
import { csrfCookieName, readCookie } from '../middleware/cookies.js';
import type { TokenService } from '../service/tokenService.js';
import type { CsrfService } from '../service/csrfService.js';
import type { AuditWriter } from '../service/auditWriter.js';
import type { RateLimitService } from '../service/rateLimitService.js';
import type { GetAuthUser } from '../middleware/requireAuth.js';
import { sanitizeDisplayName } from '../service/displayName.js';
import { validateIdempotencyKey, type IdempotencyService } from '../service/idempotencyService.js';
import { updateDisplayNameBody } from './schemas.js';
import type { IUserRepo, IPersonalSubscriptionRepo, IPersonalPlanRepo, IMembershipRepo } from '../repository/interfaces.js';

export interface ConsoleMeRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  auditWriter: AuditWriter;
  rateLimiter: RateLimitService;
  idempotencyService: IdempotencyService;
  consoleOrigin: string;
  userRepo: IUserRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  personalPlanRepo: IPersonalPlanRepo;
  membershipRepo: IMembershipRepo;
}

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function sessionIdOf(req: FastifyRequest): string | undefined {
  return (req as unknown as { authSessionId?: string }).authSessionId;
}

/** /api/console/me（§6）：当前用户、个人订阅、平台角色布尔（切片 4 前恒 false）、组织摘要。 */
export async function consoleMeRoutes(app: FastifyInstance, opts: ConsoleMeRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);

  app.register(consoleSession, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console',
    scope: ['console'],
    routes: async (child) => {
      child.get('/api/console/me', async (req, reply) => {
        const userId = (req as unknown as { authUserId: number }).authUserId;
        const user = await opts.userRepo.findById(userId);
        if (!user) return rejectConsole(reply, 401, 'UNAUTHORIZED', 'unauthorized');
        const subscription = await opts.personalSubscriptionRepo.findByUserId(userId);
        const plan = subscription ? await opts.personalPlanRepo.findById(subscription.planId) : undefined;
        const organizations = await opts.membershipRepo.listActiveByUserWithOrg(userId);
        reply.send({
          user: {
            userId: String(user.id),
            email: user.email,
            displayName: user.displayName ?? null,
            emailVerified: !!user.emailVerifiedTime,
            status: user.status,
            lastLoginTime: user.lastLoginTime ? user.lastLoginTime.toISOString() : null,
          },
          subscription: subscription
            ? {
                planCode: plan?.code ?? null,
                status: subscription.status,
                periodEndTime: subscription.periodEndTime ? subscription.periodEndTime.toISOString() : null,
              }
            : null,
          platformAdmin: user.role === 'platform_admin',
          organizations: organizations.map((o) => ({
            organizationId: String(o.organizationId),
            name: o.name,
            role: o.role,
          })),
        });
      });

      child.patch('/api/console/me', { schema: { body: updateDisplayNameBody } }, async (req, reply) => {
        // 控制台写：Origin 同源 + 会话绑定 CSRF（§4.2）。
        if (headerOf(req, 'origin') !== opts.consoleOrigin) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'forbidden');
        }
        const sessionId = sessionIdOf(req);
        if (!sessionId || !opts.csrfService.verify(readCookie(req, csrfCookieName()), headerOf(req, 'x-csrf-token'), sessionId)) {
          return rejectConsole(reply, 403, 'FORBIDDEN', 'csrf validation failed');
        }
        const userId = (req as unknown as { authUserId: number }).authUserId;
        await opts.rateLimiter.hit(`console:me:patch:${userId}`, 60, 10);

        const { displayName } = req.body as { displayName: string };
        const sanitized = sanitizeDisplayName(displayName);
        const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key']);
        const requestId = (req as unknown as { requestId?: string }).requestId ?? 'unknown';

        const result = await opts.idempotencyService.run({
          actorUserId: userId,
          sessionId: sessionId,
          method: 'PATCH',
          normalizedPath: '/api/console/me',
          idempotencyKey,
          requestBody: req.body,
          business: async (tx) => {
            await opts.userRepo.updateDisplayNameInTx(tx, userId, sanitized);
            const updated = await opts.userRepo.findByIdInTx(tx, userId);
            await opts.auditWriter.writeInTx(tx, {
              eventType: 'account.displayName.changed',
              result: 'success',
              actorUserId: userId,
              requestId,
            });
            return {
              status: 200,
              body: { user: { userId: String(userId), displayName: updated?.displayName ?? sanitized } },
            };
          },
        });

        reply.code(result.status).send(result.body);
      });
    },
  });
}