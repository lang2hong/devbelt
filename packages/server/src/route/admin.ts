import type { FastifyInstance } from 'fastify';
import { requireRole } from '../middleware/requireRole.js';
import { sendError } from '../middleware/errorHandler.js';
import type { AdminService, UpdateUserInput } from '../service/adminService.js';
import type { PaymentService } from '../service/paymentService.js';
import type { PlanCode } from '../domain/enums.js';
import type { PaymentPeriod } from '../adapter/paymentProvider.js';

export interface AdminRouteOptions {
  adminService: AdminService;
  paymentService: PaymentService;
}

/**
 * 管理员路由（RBAC admin 专用）：
 * GET    /admin/users              列用户（分页）
 * PATCH  /admin/users/:id         改 role/plan/status
 * POST   /admin/users/:id/renew    手动续费 {planCode, period, provider?}
 */
export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions): Promise<void> {
  app.register(requireRole(['admin']), {
    routes: async (child) => {
      child.get('/admin/users', async (req, reply) => {
        const limit = Number((req.query as any).limit || 50);
        const offset = Number((req.query as any).offset || 0);
        const users = await opts.adminService.listUsers(limit, offset);
        reply.send({ users });
      });

      child.patch('/admin/users/:id', async (req, reply) => {
        const id = Number((req.params as any).id);
        const input = req.body as UpdateUserInput;
        try {
          await opts.adminService.updateUser(id, input);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/admin/users/:id/renew', async (req, reply) => {
        const id = Number((req.params as any).id);
        const { planCode, period, provider } = req.body as any;
        try {
          const sub = await opts.paymentService.renew(id, planCode as PlanCode, period as PaymentPeriod, provider);
          reply.send({ subscription: sub });
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}
