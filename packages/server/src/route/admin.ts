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
 * GET    /admin/plans                    列套餐
 * POST   /admin/plans/:code               编辑套餐（name/价格/配额/features）
 * GET    /admin/users                    列用户（分页，带订阅摘要 + total）
 * GET    /admin/users/:id                用户详情（套餐/订阅/会话/用量）
 * PATCH  /admin/users/:id                改 role/plan/status
 * POST   /admin/users/:id/renew          手动续费 {planCode, period, provider?}
 * GET    /admin/users/:id/sessions       列活跃会话
 * DELETE /admin/users/:id/sessions/:sid  吊销指定会话
 * GET    /admin/subscriptions            全部订阅明细
 */
export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions): Promise<void> {
  app.register(requireRole(['admin']), {
    routes: async (child) => {
      child.get('/admin/plans', async (_req, reply) => {
        const plans = await opts.adminService.listPlans();
        reply.send({ plans });
      });

      child.post('/admin/plans/:code', async (req, reply) => {
        const code = (req.params as any).code as PlanCode;
        try {
          await opts.adminService.updatePlan(code, req.body as any);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users', async (req, reply) => {
        const limit = Number((req.query as any).limit || 50);
        const offset = Number((req.query as any).offset || 0);
        const [total, users] = await Promise.all([
          opts.adminService.countUsers(),
          opts.adminService.listUsers(limit, offset),
        ]);
        reply.send({ total, users });
      });

      child.get('/admin/users/:id', async (req, reply) => {
        const id = Number((req.params as any).id);
        try {
          const detail = await opts.adminService.getUserDetail(id);
          reply.send(detail);
        } catch (e) {
          sendError(reply, e);
        }
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

      child.get('/admin/users/:id/sessions', async (req, reply) => {
        const id = Number((req.params as any).id);
        const sessions = await opts.adminService.listSessions(id);
        reply.send({ sessions });
      });

      child.delete('/admin/users/:id/sessions/:sid', async (req, reply) => {
        const id = Number((req.params as any).id);
        const sid = Number((req.params as any).sid);
        try {
          await opts.adminService.revokeSession(id, sid);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users/:id/devices', async (req, reply) => {
        const id = Number((req.params as any).id);
        const devices = await opts.adminService.listDevices(id);
        reply.send({ devices });
      });

      child.get('/admin/users/:id/devices/:deviceId/events', async (req, reply) => {
        const id = Number((req.params as any).id);
        const deviceId = String((req.params as any).deviceId);
        const events = await opts.adminService.listDeviceEvents(id, deviceId);
        reply.send({ events });
      });

      child.get('/admin/users/:id/connections', async (req, reply) => {
        const id = Number((req.params as any).id);
        const connections = await opts.adminService.listConnections(id);
        reply.send({ connections });
      });

      child.get('/admin/users/:id/sync-events', async (req, reply) => {
        const id = Number((req.params as any).id);
        const syncEvents = await opts.adminService.listSyncEvents(id);
        reply.send({ syncEvents });
      });

      child.get('/admin/users/:id/usage-events', async (req, reply) => {
        const id = Number((req.params as any).id);
        const usageEvents = await opts.adminService.listUsageEvents(id);
        reply.send({ usageEvents });
      });

      child.get('/admin/subscriptions', async (_req, reply) => {
        const subscriptions = await opts.adminService.listSubscriptions();
        reply.send({ subscriptions });
      });
    },
  });
}