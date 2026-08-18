import type { FastifyInstance } from 'fastify';
import { requireRole } from '../middleware/requireRole.js';
import type { GetAuthUser, GetAuthSession } from '../middleware/requireAuth.js';
import { sendError } from '../middleware/errorHandler.js';
import type { AdminService, UpdateUserInput } from '../service/adminService.js';
import type { PaymentService } from '../service/paymentService.js';
import type { PlanCode } from '../domain/enums.js';
import type { PaymentPeriod } from '../adapter/paymentProvider.js';
import {
  allowlistBody,
  allowlistIpParam,
  deviceEventsParams,
  idParam,
  paginationQuery,
  planCodeParam,
  rateLimitBucketParam,
  renewBody,
  sessionIdParams,
  trafficQuery,
  updatePlanBody,
  updateRateLimitBody,
  updateUserBody,
} from './schemas.js';
import type { ITrafficRepo } from '../repository/interfaces.js';
import type { TrafficCollector } from '../observability/trafficCollector.js';
import { TrafficReporter } from '../observability/trafficReporter.js';
import type { RateLimitConfig } from '../ratelimit/rateLimitConfig.js';
import type { RateLimitBucket } from '../ratelimit/rules.js';

export interface AdminRouteOptions {
  adminService: AdminService;
  paymentService: PaymentService;
  getUser?: GetAuthUser;
  getSession?: GetAuthSession;
  trafficRepo?: ITrafficRepo;
  trafficCollector?: TrafficCollector;
  rateLimitConfig?: RateLimitConfig;
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
          await opts.adminService.updatePlan(code, req.body as any);
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
          await opts.adminService.updateUser(id, input);
          reply.send({ ok: true });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.post('/admin/users/:id/renew', { schema: { params: idParam, body: renewBody } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        const { planCode, period, provider } = req.body as any;
        try {
          const sub = await opts.paymentService.renew(id, planCode as PlanCode, period as PaymentPeriod, provider);
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
          await opts.adminService.revokeSession(id, sid);
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

      child.get('/admin/users/:id/devices/:deviceId/events', { schema: { params: deviceEventsParams } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        const deviceId = String((req.params as any).deviceId);
        try {
          const events = await opts.adminService.listDeviceEvents(id, deviceId);
          reply.send({ events });
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

      child.get('/admin/users/:id/sync-events', { schema: { params: idParam } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        try {
          const syncEvents = await opts.adminService.listSyncEvents(id);
          reply.send({ syncEvents });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/users/:id/usage-events', { schema: { params: idParam } }, async (req, reply) => {
        const id = Number((req.params as any).id);
        try {
          const usageEvents = await opts.adminService.listUsageEvents(id);
          reply.send({ usageEvents });
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
       * 流量报表。
       *
       * 返回的是**已聚合好**的展示数据（表格行 + 两条序列），不是原始行。
       * 理由见 TrafficReporter 的注释：admin-ui 没有测试运行器，聚合逻辑
       * 放在这边才测得到。
       */
      child.get('/admin/traffic', { schema: { querystring: trafficQuery } }, async (req, reply) => {
        const hours = Number((req.query as any).hours ?? 24);
        try {
          if (!opts.trafficCollector) {
            reply.send(emptyTrafficReport(hours));
            return;
          }
          // 先把内存里攒的落库，否则刚发生的请求要等下个 flush 周期才看得到
          await req.server.flushTraffic?.();
          const reporter = new TrafficReporter(opts.trafficRepo, opts.trafficCollector);
          reply.send(await reporter.report(hours));
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.get('/admin/rate-limits', async (_req, reply) => {
        try {
          const cfg = opts.rateLimitConfig;
          reply.send({
            rules: cfg ? cfg.listAll() : [],
            allowlist: cfg ? cfg.listAllowlist() : [],
          });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.patch(
        '/admin/rate-limits/:bucket',
        { schema: { params: rateLimitBucketParam, body: updateRateLimitBody } },
        async (req, reply) => {
          const bucket = (req.params as any).bucket as RateLimitBucket;
          try {
            if (!opts.rateLimitConfig) {
              reply.code(503).send({ message: 'rate limiting not configured', code: 'UNAVAILABLE' });
              return;
            }
            await opts.rateLimitConfig.update(bucket, req.body as any);
            reply.send({ ok: true, rules: opts.rateLimitConfig.listAll() });
          } catch (e) {
            sendError(reply, e);
          }
        },
      );

      child.post(
        '/admin/rate-limits/allowlist',
        { schema: { body: allowlistBody } },
        async (req, reply) => {
          const { ip, note } = req.body as any;
          try {
            if (!opts.rateLimitConfig) {
              reply.code(503).send({ message: 'rate limiting not configured', code: 'UNAVAILABLE' });
              return;
            }
            await opts.rateLimitConfig.addAllowlist(ip, note);
            reply.send({ ok: true, allowlist: opts.rateLimitConfig.listAllowlist() });
          } catch (e) {
            sendError(reply, e);
          }
        },
      );

      child.delete(
        '/admin/rate-limits/allowlist/:ip',
        { schema: { params: allowlistIpParam } },
        async (req, reply) => {
          const ip = String((req.params as any).ip);
          try {
            if (!opts.rateLimitConfig) {
              reply.code(503).send({ message: 'rate limiting not configured', code: 'UNAVAILABLE' });
              return;
            }
            await opts.rateLimitConfig.removeAllowlist(ip);
            reply.send({ ok: true, allowlist: opts.rateLimitConfig.listAllowlist() });
          } catch (e) {
            sendError(reply, e);
          }
        },
      );
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