import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser, type GetAuthSession } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import type { IUsageEventRepo } from '../repository/interfaces.js';
import { usageBody } from './schemas.js';
import { readDeviceId } from './deviceHeaders.js';

export interface UsageRouteOptions {
  usageEventRepo: IUsageEventRepo;
  getUser?: GetAuthUser;
  getSession?: GetAuthSession;
}

/**
 * 用量上报路由（需认证）：POST /api/usage { connectionOpens, queryExecutes }。
 * 客户端在同步时批量上报累计计数；服务端拆成 connection_open / query_execute 两条事件。
 */
export async function usageRoutes(app: FastifyInstance, opts: UsageRouteOptions): Promise<void> {
  app.register(authScope, {
    getUser: opts.getUser,
    getSession: opts.getSession,
    routes: async (child) => {
      child.post('/api/usage', { schema: { body: usageBody } }, async (req, reply) => {
        const userId = req.user.sub as number;
        const deviceId = readDeviceId(req);
        const { connectionOpens, queryExecutes } = req.body as any;
        try {
          if (Number(connectionOpens) > 0) {
            await opts.usageEventRepo.record(userId, deviceId, 'connection_open', Number(connectionOpens));
          }
          if (Number(queryExecutes) > 0) {
            await opts.usageEventRepo.record(userId, deviceId, 'query_execute', Number(queryExecutes));
          }
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}