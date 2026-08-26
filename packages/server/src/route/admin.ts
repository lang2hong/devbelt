import type { FastifyInstance } from 'fastify';
import { requireRole } from '../middleware/requireRole.js';
import type { GetAuthUser, GetAuthSession } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import type { AdminService, UpdateUserInput } from '../service/adminService.js';
import type { PaymentService } from '../service/paymentService.js';
import type { PlanCode } from '../domain/enums.js';
import type { PaymentPeriod } from '../adapter/paymentProvider.js';
import type { TrafficCollector } from '../observability/trafficCollector.js';
import { TrafficReporter } from '../observability/trafficReporter.js';
import {
  idParam,
  paginationQuery,
  planCodeParam,
  renewBody,
  sessionIdParams,
  trafficQuery,
  updatePlanBody,
  updateUserBody,
} from './schemas.js';

export interface AdminRouteOptions {
  adminService: AdminService;
  paymentService: PaymentService;
  getUser?: GetAuthUser;
  getSession?: GetAuthSession;
  trafficCollector?: TrafficCollector;
}

/**
 * 管理员路由（RBAC admin 专用）：
 * GET    /admin/plans                    列套餐
 * POST   /admin/plans/:code               编辑套餐（name/价格/配额/features）
 * GET    /admin/users                    列用户（分页，带订阅摘要 + total）
 * GET    /admin/users/:id                用户详情（套餐/订阅/会话/用量）
 * PATCH  /admin/users/:id                改 role/status（v2 无 planCode，套餐由组织订阅推导）
 * POST   /admin/organizations/:id/renew  手动续费 {planCode, period, provider?}
 * GET    /admin/users/:id/sessions       列活跃会话
 * DELETE /admin/users/:id/sessions/:sid  吊销指定会话
 * GET    /admin/subscriptions            全部订阅明细
 * GET    /admin/audit                    管理操作留痕（分页）
 */
export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions): Promise<void> {
  /**
   * 操作者上下文。
   *
   * `req.user.sub` 由 requireRole 的 jwtVerify + DB 复核填好，不是客户端可控值。
   * ip 取 `req.ip`（受 trustProxy 影响，与限流分桶、devices.ip 同一来源）。
   */
  const actorOf = (req: { user: { sub: number }; ip: string }) => ({ userId: req.user.sub, ip: req.ip });

  app.register(requireRole(['admin']), {
    getUser: opts.getUser,
    getSession: opts.getSession,
    routes: async (child) => {
      child.get('/admin/plans', async (_req, reply) => {
        try {
          const plans = await opts.adminService.listPlans();
          reply.send({ plans });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/admin/plans/:code', { schema: { params: planCodeParam, body: updatePlanBody } }, async (req, reply) => {
        const code = (req.params as any).code as PlanCode;
        try {
          await opts.adminService.updatePlan(code, req.body as any, actorOf(req as any));
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users', { schema: { querystring: paginationQuery } }, async (req, reply) => {
        // schema 保证是整数且在范围内；`?limit=abc` 已在此之前被 400 拦下
        const limit = Number((req.query as any).limit ?? 50);
        const offset = Number((req.query as any).offset ?? 0);
        try {
          const [total, users] = await Promise.all([
            opts.adminService.countUsers(),
            opts.adminService.listUsers(limit, offset),
          ]);
          reply.send({ total, users });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users/:id', { schema: { params: idParam } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        try {
          const detail = await opts.adminService.getUserDetail(id);
          reply.send(detail);
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.patch('/admin/users/:id', { schema: { params: idParam, body: updateUserBody } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        const input = req.body as UpdateUserInput;
        try {
          await opts.adminService.updateUser(id, input, actorOf(req as any));
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/admin/organizations/:id/renew', { schema: { params: idParam, body: renewBody } }, async (req, reply) => {
        const organizationId = Number((req.params as any).id);
        const { planCode, period, provider } = req.body as any;
        try {
          // P3-16: admin 是目标组织成员时标记 selfBenefit（self-dealing 审计）
          const isMember = await opts.adminService.isMemberOf(organizationId, (req as any).user.sub);
          // 手动续费等于免费发放付费套餐，是最需要留痕的一类管理操作
          await opts.adminService.recordAudit(actorOf(req as any), 'organization.renew', 'organization', String(organizationId), {
            planCode, period, provider: provider ?? 'manual',
            ...(isMember ? { selfBenefit: true } : {}),
          });
          const sub = await opts.paymentService.renew(organizationId, planCode as PlanCode, period as PaymentPeriod, provider);
          reply.send({ subscription: sub });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users/:id/sessions', { schema: { params: idParam } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        try {
          const sessions = await opts.adminService.listSessions(id);
          reply.send({ sessions });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.delete('/admin/users/:id/sessions/:sid', { schema: { params: sessionIdParams } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        const sid = Number((req.params as any).sid);
        try {
          await opts.adminService.revokeSession(id, sid, actorOf(req as any));
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users/:id/devices', { schema: { params: idParam } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        try {
          const devices = await opts.adminService.listDevices(id);
          reply.send({ devices });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users/:id/connections', { schema: { params: idParam } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        try {
          const connections = await opts.adminService.listConnections(id);
          reply.send({ connections });
        } catch (e) {
          sendError(reply, e);
        }
      });

      /**
       * 管理操作留痕。
       *
       * 只读、只给 admin。放在 admin 作用域下没有额外风险：能读留痕的人
       * 本来就能做被留痕的操作。
       */
      child.get('/admin/audit', { schema: { querystring: paginationQuery } }, async (req, reply) => {
        const limit = Number((req.query as any).limit ?? 50);
        const offset = Number((req.query as any).offset ?? 0);
        try {
          reply.send(await opts.adminService.listAudit(limit, offset));
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/subscriptions', async (_req, reply) => {
        try {
          const subscriptions = await opts.adminService.listSubscriptions();
          reply.send({ subscriptions });
        } catch (e) {
          sendError(reply, e);
        }
      });

      /**
       * 流量报表（v2：只读内存）。
       *
       * 返回已经聚合好的展示数据，不是原始行。理由见 TrafficReporter 的注释：
       * admin-ui 没有测试运行器，聚合逻辑放在这边才测得到。
       */
      child.get('/admin/traffic', { schema: { querystring: trafficQuery } }, async (req, reply) => {
        const hours = Number((req.query as any).hours ?? 24);
        try {
          if (!opts.trafficCollector) {
            reply.send(emptyTrafficReport(hours));
            return;
          }
          const reporter = new TrafficReporter(opts.trafficCollector);
          reply.send(reporter.report(hours));
        } catch (e) {
          sendError(reply, e);
        }
      });

    },
  });
}

function emptyTrafficReport(hours: number) {
  return {
    hours,
    total: 0,
    routes: [],
    hourly: [],
    minutes: [],
    blocked: [],
    blockedTotal: 0,
  };
}
