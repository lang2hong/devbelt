import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../../../middleware/requireAuth.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { AiQuotaService } from '../service/aiQuotaService.js';
import type { AiTopupService } from '../service/aiTopupService.js';

export interface AiQuotaRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  quota: AiQuotaService;
  topup: AiTopupService;
}

/** `GET /api/ai/usage`（双段配额快照）+ `GET /api/ai/skus`（加油包档位，P9.1）。 */
export async function aiQuotaRoutes(app: FastifyInstance, opts: AiQuotaRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: ['extension', 'console'],
    scope: ['account'],
    routes: async (child) => {
      child.get('/api/ai/usage', async (req, reply) => {
        const userId = (req as unknown as { authUserId: number }).authUserId;
        reply.send(await opts.quota.getUsage(userId));
      });

      child.get('/api/ai/skus', async (_req, reply) => {
        reply.send({ items: await opts.topup.listSkus() });
      });
    },
  });
}