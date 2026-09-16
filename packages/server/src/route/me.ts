import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import { sendError } from '../middleware/errorHandler.js';
import type { IUserRepo, IPersonalSubscriptionRepo, IPlanRepo } from '../repository/interfaces.js';
import type { User } from '../domain/entities.js';
import { deriveEntitlement } from '../service/entitlement.js';

export interface MeRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  userRepo: IUserRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  planRepo: IPlanRepo;
}

/** /api/me、/api/personal/subscription（需认证）。 */
export async function meRoutes(app: FastifyInstance, opts: MeRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: ['extension', 'console'],
    scope: ['account'],
    routes: async (child) => {
      child.get('/api/me', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          const user = await opts.userRepo.findById(userId);
          if (!user) return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
          const subscription = await opts.personalSubscriptionRepo.findByUserId(userId);
          const plan = subscription ? await opts.planRepo.findById(subscription.planId) : undefined;
          const freePlan = await opts.planRepo.findByCode('free');
          reply.send({
            user: sanitizeUser(user),
            subscription: subscription
              ? {
                  planCode: plan?.code ?? null,
                  status: subscription.status,
                  entitlement: deriveEntitlement(subscription, plan, freePlan),
                  periodStartTime: subscription.periodStartTime.toISOString(),
                  periodEndTime: subscription.periodEndTime ? subscription.periodEndTime.toISOString() : null,
                }
              : null,
          });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/api/personal/subscription', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          const subscription = await opts.personalSubscriptionRepo.findByUserId(userId);
          const plan = subscription ? await opts.planRepo.findById(subscription.planId) : undefined;
          const freePlan = await opts.planRepo.findByCode('free');
          reply.send({
            planCode: plan?.code ?? null,
            status: subscription?.status ?? null,
            entitlement: subscription ? deriveEntitlement(subscription, plan, freePlan) : null,
          });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });

  function sanitizeUser(user: User) {
    return {
      userId: String(user.id),
      email: user.email,
      displayName: user.displayName,
      emailVerified: !!user.emailVerifiedTime,
      status: user.status,
      lastLoginTime: user.lastLoginTime ? user.lastLoginTime.toISOString() : null,
    };
  }
}