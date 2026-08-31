import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import { sendError } from '../middleware/errorHandler.js';
import type { IUserRepo, IPersonalSubscriptionRepo, IPersonalPlanRepo } from '../repository/interfaces.js';
import type { User } from '../domain/entities.js';

export interface MeRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  userRepo: IUserRepo;
  personalSubscriptionRepo: IPersonalSubscriptionRepo;
  personalPlanRepo: IPersonalPlanRepo;
}

/** /api/me、/api/personal/subscription（需认证）。 */
export async function meRoutes(app: FastifyInstance, opts: MeRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    routes: async (child) => {
      child.get('/api/me', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          const user = await opts.userRepo.findById(userId);
          if (!user) return reply.code(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
          const subscription = await opts.personalSubscriptionRepo.findByUserId(userId);
          const plan = subscription ? await opts.personalPlanRepo.findById(subscription.planId) : undefined;
          reply.send({
            user: sanitizeUser(user),
            subscription: subscription
              ? {
                  planCode: plan?.code ?? null,
                  status: subscription.status,
                  entitlement: subscription.entitlementSnapshot,
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
          const plan = subscription ? await opts.personalPlanRepo.findById(subscription.planId) : undefined;
          reply.send({
            planCode: plan?.code ?? null,
            status: subscription?.status ?? null,
            entitlement: subscription?.entitlementSnapshot ?? null,
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