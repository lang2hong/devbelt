/**
 * 进程内请求/错误计数器（P3 §11.3「按 (route, method, status_code) 维度打点」）。
 *
 * 刻意保持最小、无外部依赖：只提供累加与快照，供部署侧（Prometheus / 云监控等）
 * 按需采集，或由日志层抽样输出。告警阈值与导出方式见 P3-运维运行手册.md。
 *
 * 键使用 `http:<method>:<route>:<status>`；route 用 Fastify 的参数化模板（routeOptions.url），
 * 未命中回退脱敏后的 URL 路径。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { redactUrl } from '../middleware/requestLogging.js';

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();

  increment(key: string, by = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** 按 (method, route, status) 维度打点的标准键。 */
  requestKey(method: string, route: string, status: number): string {
    return `http:${method}:${route}:${status}`;
  }

  /** 当前全部计数器的只读快照。 */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

/**
 * 挂接请求速率/错误率计数（§11.3）。
 *
 * - route 取 Fastify `routeOptions.url`（命中路由的参数化模板，天然无高基数）；
 *   未命中（404 等）回退 `redactUrl(去 query)` 归一化，避免把原始 token/ID 打进键。
 * - 计数无 path 参数实际值、无 query、无 token、无用户标识，杜绝高基数与敏感信息。
 */
export function attachRequestMetrics(app: FastifyInstance, metrics: MetricsRegistry): void {
  app.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply) => {
    const routeOpts = (req as unknown as { routeOptions?: { url?: string; method?: string | string[] } }).routeOptions;
    // route 取 Fastify 的参数化模板（routeOptions.url），未命中（404）回退脱敏后的去 query 路径。
    const route = routeOpts?.url ?? redactUrl(req.url.split('?')[0]);
    const rawMethod = routeOpts?.method ?? req.method;
    const method = Array.isArray(rawMethod) ? rawMethod.join(',') : rawMethod;
    metrics.increment(metrics.requestKey(method, route, reply.statusCode));
  });
}