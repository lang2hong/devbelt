import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../../../middleware/requireAuth.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { AiQuotaService } from '../service/aiQuotaService.js';

export interface AiQuotaRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  quota: AiQuotaService;
}

/** `GET /api/ai/usage`：当月用量快照（客户端配额条；单段月额度）。 */
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
    },
  });
}