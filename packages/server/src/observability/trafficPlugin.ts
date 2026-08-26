import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TrafficCollector } from './trafficCollector.js';

export const UNMATCHED_ROUTE = '__unmatched__';
export const STATIC_ROUTE = '__static__';

export interface TrafficPluginOptions {
  collector: TrafficCollector;
}

export function routeKeyOf(req: FastifyRequest): string {
  const template = req.routeOptions?.url;
  if (!template) return UNMATCHED_ROUTE;
  if (template.startsWith('/admin/') && template.includes('*')) return STATIC_ROUTE;
  return template.length > 80 ? template.slice(0, 80) : template;
}

/**
 * 流量采集插件（纯内存 onResponse 钩子）。
 * v2：不再 flush 落库。采集即内存 Map 自增，零 I/O。
 */
export async function registerTrafficPlugin(
  app: FastifyInstance,
  opts: TrafficPluginOptions,
): Promise<void> {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    opts.collector.record(routeKeyOf(req), reply.statusCode);
  });
}
