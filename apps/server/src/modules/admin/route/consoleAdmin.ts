import type { FastifyInstance } from 'fastify';
import { consoleSession } from '../../../middleware/requireAuth.js';
import { registerConsoleErrorHandler } from '../../../middleware/consoleError.js';
import {
  RATE_EXPORT_MAX,
  RATE_EXPORT_WINDOW_S,
  RATE_READ_MAX,
  RATE_READ_WINDOW_S,
  RATE_WRITE_MAX,
  RATE_WRITE_WINDOW_S,
  userIdOf,
  type AdminCtx,
  type ConsoleAdminRouteOptions,
} from './consoleAdminContext.js';
import { registerUserAdminRoutes } from './consoleAdminUsers.js';
import { registerBillingAdminRoutes } from './consoleAdminBilling.js';
import { registerAuditAdminRoutes } from './consoleAdminAudit.js';
import { registerPlanAdminRoutes } from './consoleAdminPlans.js';
import { registerVersionAdminRoutes } from './consoleAdminVersion.js';
import { registerFeedbackAdminRoutes } from './consoleAdminFeedback.js';

export type { ConsoleAdminRouteOptions } from './consoleAdminContext.js';

/**
 * 平台运营路由（P3 §6，切片 4）：全部 console-only + requireAdmin。
 *
 * 组合根只负责守卫作用域与限流器装配；具体资源拆在 consoleAdmin*.ts，
 * 保证路径/守卫/schema 不变的同时避免单文件继续膨胀。
 */
export async function consoleAdminRoutes(app: FastifyInstance, opts: ConsoleAdminRouteOptions): Promise<void> {
  registerConsoleErrorHandler(app);
  const ctx: AdminCtx = {
    opts,
    svc: opts.adminService,
    readLimit: (req) => opts.rateLimiter.hit(`console:admin:read:${userIdOf(req)}`, RATE_READ_WINDOW_S, RATE_READ_MAX),
    writeLimitInTx: (tx, req) => opts.rateLimiter.hitInTx(tx, `console:admin:write:${userIdOf(req)}`, RATE_WRITE_WINDOW_S, RATE_WRITE_MAX),
    exportLimitInTx: (tx, req) => opts.rateLimiter.hitInTx(tx, `console:admin:export:${userIdOf(req)}`, RATE_EXPORT_WINDOW_S, RATE_EXPORT_MAX),
  };
  const base = {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: 'console' as const,
    scope: ['console'],
    requireAdmin: true,
  };

  await app.register(consoleSession, {
    ...base,
    routes: async (child) => {
      registerUserAdminRoutes(child, ctx);
      registerBillingAdminRoutes(child, ctx);
      registerAuditAdminRoutes(child, ctx);
      registerPlanAdminRoutes(child, ctx);
      registerFeedbackAdminRoutes(child, ctx);
    },
  });

  // 版本（仅平台管理员）
  await app.register(consoleSession, {
    ...base,
    routes: async (child) => {
      registerVersionAdminRoutes(child, ctx);
    },
  });
}