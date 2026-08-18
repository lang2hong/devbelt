import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser, type GetAuthSession } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import type { SubscriptionService } from '../service/subscriptionService.js';

export interface MeRouteOptions {
  subscriptionService: SubscriptionService;
  getUser?: GetAuthUser;
  getSession?: GetAuthSession;
}

/** /api/me 路由：返回当前用户 + 套餐 + 订阅 + 配额用量（需认证） */
export async function meRoutes(app: FastifyInstance, opts: MeRouteOptions): Promise<void> {
  app.register(authScope, {
    getUser: opts.getUser,
    getSession: opts.getSession,
    routes: async (child) => {
      child.get('/api/me', async (req, reply) => {
        const userId = req.user.sub as number;
        try {
          const me = await opts.subscriptionService.getMe(userId);
          reply.send(me);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}
