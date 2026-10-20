import type { FastifyInstance } from 'fastify';
import type { AdminCtx } from './consoleAdminContext.js';

/** 控制台版本号（仅平台管理员；不缓存）。 */
export function registerVersionAdminRoutes(child: FastifyInstance, ctx: AdminCtx): void {
  child.get('/api/console/version', async (req, reply) => {
    await ctx.readLimit(req);
    reply.header('Cache-Control', 'no-store');
    reply.send({
      consoleApiVersion: ctx.opts.consoleApiVersion,
      serverVersion: ctx.opts.serverVersion,
      consoleBuildId: null,
      buildTime: null,
    });
  });
}