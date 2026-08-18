import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ITrafficRepo } from '../repository/interfaces.js';
import { TrafficCollector } from './trafficCollector.js';

/** 未匹配到任何路由（404、探测扫描）的归并桶 */
export const UNMATCHED_ROUTE = '__unmatched__';
/** admin-ui 静态资源的归并桶 */
export const STATIC_ROUTE = '__static__';

export interface TrafficPluginOptions {
  collector: TrafficCollector;
  repo?: ITrafficRepo;
  /** flush 周期（毫秒），默认 60s */
  flushIntervalMs?: number;
}

/**
 * 从请求里取出用于统计的路由标识。
 *
 * 必须是**路由模板**（`/admin/users/:id`）而不是 `req.url`（`/admin/users/7`）：
 * 后者基数无界，一万个用户就是一万个 route 值，traffic_stats 会被打爆，
 * 而且这张表的 route 列只有 VARCHAR(80)。
 *
 * 三种拿不到模板的情况：
 * - 404：路由没匹配上，routeOptions.url 为 undefined → `__unmatched__`
 * - 静态资源：@fastify/static 的通配路由，逐个 chunk 记没意义 → `__static__`
 * - 超长模板：截断到 80 字符，与 DB 列宽对齐
 */
export function routeKeyOf(req: FastifyRequest): string {
  const template = req.routeOptions?.url;
  if (!template) return UNMATCHED_ROUTE;
  if (template.startsWith('/admin/') && template.includes('*')) return STATIC_ROUTE;
  return template.length > 80 ? template.slice(0, 80) : template;
}

/**
 * 流量采集插件：onResponse 钩子 + 定时 flush。
 *
 * 采集本身只在内存里做 Map 自增，不碰 I/O —— 落库由定时器批量做，
 * 否则每个请求都要多一次 INSERT，本末倒置。
 *
 * **定时器必须在 onClose 里清掉**，否则 `setInterval` 会一直持有事件循环
 * 引用：生产环境表现为进程收到 SIGTERM 后不退出，测试里表现为 vitest 卡住
 * 不结束。这是这类插件最常见的坑，专门有用例盯着。
 */
export async function registerTrafficPlugin(
  app: FastifyInstance,
  opts: TrafficPluginOptions,
): Promise<void> {
  const { collector, repo } = opts;
  const intervalMs = opts.flushIntervalMs ?? 60_000;

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    collector.record(routeKeyOf(req), reply.statusCode);
  });

  /**
   * 落库一批。失败时把数据放回 collector，下个周期重试。
   *
   * 两批数据分别处理：stats 失败不应该连带丢掉 blocked 记录，
   * 它们是不同表、不同价值（blocked 是排查限流误伤的唯一依据）。
   */
  const flush = async (): Promise<void> => {
    if (!repo) return;
    const stats = collector.drain();
    if (stats.length > 0) {
      try {
        await repo.upsertStats(stats);
      } catch (err) {
        collector.restore(stats);
        app.log.warn({ err, rows: stats.length }, 'traffic stats flush failed; will retry');
      }
    }
    const blocked = collector.drainBlocked();
    if (blocked.length > 0) {
      try {
        await repo.insertBlocked(blocked);
      } catch (err) {
        collector.restoreBlocked(blocked);
        app.log.warn({ err, rows: blocked.length }, 'traffic blocked flush failed; will retry');
      }
    }
  };

  const timer = setInterval(() => void flush(), intervalMs);
  // unref：flush 定时器不该是「进程还有事要做」的理由
  timer.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    // 关闭前最后一次落库，否则最后一个周期内的数据白采集了
    await flush();
  });

  // 供测试与 /admin/traffic 手动触发
  app.decorate('flushTraffic', flush);
}

declare module 'fastify' {
  interface FastifyInstance {
    flushTraffic: () => Promise<void>;
  }
}
