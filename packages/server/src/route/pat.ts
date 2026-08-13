import type { FastifyInstance } from 'fastify';
import { authScope } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import type { PatService } from '../service/patService.js';

export interface PatRouteOptions {
  patService: PatService;
}

/**
 * PAT 路由（需认证）：
 * GET    /api/auth/tokens       列 PAT
 * POST   /api/auth/tokens       建 PAT {name, scopes} → 返回明文 token（仅此次）
 * DELETE /api/auth/tokens/:id   撤 PAT
 */
export async function patRoutes(app: FastifyInstance, opts: PatRouteOptions): Promise<void> {
  app.register(authScope, {
    routes: async (child) => {
      child.get('/api/auth/tokens', async (req, reply) => {
        const userId = req.user.sub as number;
        const pats = await opts.patService.list(userId);
        reply.send({ pats });
      });

      child.post('/api/auth/tokens', async (req, reply) => {
        const userId = req.user.sub as number;
        const { name, scopes } = req.body as any;
        try {
          const r = await opts.patService.create(userId, name, scopes);
          reply.code(201).send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.delete('/api/auth/tokens/:id', async (req, reply) => {
        const userId = req.user.sub as number;
        const id = Number((req.params as any).id);
        try {
          await opts.patService.revoke(userId, id);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}
