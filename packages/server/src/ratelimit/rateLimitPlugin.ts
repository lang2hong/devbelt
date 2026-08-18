import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { TrafficCollector } from '../observability/trafficCollector.js';
import { routeKeyOf } from '../observability/trafficPlugin.js';
import type { RateLimitConfig } from './rateLimitConfig.js';
import { bucketForRoute, type RateLimitBucket } from './rules.js';

export interface RateLimitPluginOptions {
  config: RateLimitConfig;
  /** 429 会记到这里，供 /admin/traffic 排查误伤 */
  collector?: TrafficCollector;
  /** 总闸。false 时完全不注册插件 */
  enabled?: boolean;
}

/**
 * 该请求归哪个桶；undefined 表示豁免。
 *
 * method 必须一起传：`/api/sync` 上 GET 是读、PUT 是写，同一个路由模板。
 */
function bucketOf(req: FastifyRequest): RateLimitBucket | undefined {
  return bucketForRoute(req.method, req.routeOptions?.url);
}

/**
 * 注册限流。
 *
 * ## 分桶实现
 *
 * `@fastify/rate-limit` 全局只有一个 store，靠 key 区分计数器。把桶名拼进 key
 * （`${bucket}:${ip}`）就得到了按桶独立的计数器 —— 而 `max`/`timeWindow` 都
 * 支持传函数并会被 await（源码 index.js:275-276），所以每个桶可以有自己的
 * 阈值和窗口，store 的 `incr(key, cb, timeWindow, max)` 每次都按当次参数算。
 *
 * ## 豁免走 allowList 而不是 max=Infinity
 *
 * `allowList` 返回 true 时插件直接 return（源码 index.js:259-268），不碰 store、
 * 不算 max。用 `max: Infinity` 的话每个豁免请求还是会在 LRU 里占一个槽位，
 * `/health` 被监控高频轮询时纯属浪费。
 *
 * ## 429 的响应体
 *
 * 自定义 `errorResponseBuilder` 挂上 `code: 'RATE_LIMITED'`。注意插件是
 * `throw` 这个对象（index.js:375），会落到全局 errorHandler —— 那里必须有
 * 429 分支保留 message，否则「多久后可重试」会被改写成通用的 'Bad request'。
 */
export async function registerRateLimit(
  app: FastifyInstance,
  opts: RateLimitPluginOptions,
): Promise<void> {
  if (opts.enabled === false) {
    app.log.warn('rate limiting is DISABLED via RATE_LIMIT_ENABLED=false');
    return;
  }
  const cfg = opts.config;

  await app.register(rateLimit, {
    global: true,

    // key 带桶名 → 每个桶一个独立计数器
    keyGenerator: (req) => `${bucketOf(req) ?? 'exempt'}:${req.ip}`,

    /**
     * 三种豁免，都在这里判：
     *  1. 路由本身豁免（/health、静态资源）
     *  2. 该桶被管理员关掉了
     *  3. IP 在白名单（共用出口 IP 的办公室）
     */
    allowList: (req) => {
      const bucket = bucketOf(req);
      if (!bucket) return true;
      if (!cfg.get(bucket).enabled) return true;
      return cfg.isAllowed(req.ip);
    },

    max: (req) => {
      const bucket = bucketOf(req);
      return bucket ? cfg.get(bucket).maxRequests : Number.MAX_SAFE_INTEGER;
    },

    timeWindow: (req) => {
      const bucket = bucketOf(req);
      return (bucket ? cfg.get(bucket).windowSeconds : 60) * 1000;
    },

    /**
     * store 出错时放行而不是拒绝。
     *
     * LocalStore 是纯内存的，实际不会出错；但万一将来换成 Redis store，
     * Redis 抖动不应该让整个服务不可用 —— 限流是防滥用的，不是核心链路。
     */
    skipOnError: true,

    onExceeded: (req, key) => {
      opts.collector?.recordBlocked({
        ip: req.ip,
        route: routeKeyOf(req),
        bucket: bucketOf(req) ?? 'unknown',
      });
      req.log.warn({ key, route: routeKeyOf(req), ip: req.ip }, 'rate limit exceeded');
    },

    errorResponseBuilder: (_req, ctx) => {
      const err = new Error(`Too many requests, retry in ${ctx.after}`) as Error & {
        statusCode: number;
        code: string;
      };
      err.statusCode = ctx.statusCode;
      err.code = 'RATE_LIMITED';
      return err;
    },
  });
}
