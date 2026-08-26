import {
  DEFAULT_RULES,
  RATE_LIMIT_BUCKETS,
  type RateLimitBucket,
  type RateLimitRule,
} from './rules.js';

/**
 * 限流配置（纯内存，v2）。
 *
 * v2 移除了 rate_limit_rules / rate_limit_allowlist 表（设计文档 §4「限流交应用
 * 配置」）。阈值回归代码常量 DEFAULT_RULES，不再支持后台实时调阈值 / IP 白名单。
 * 逃生通道仍是 RATE_LIMIT_ENABLED=false。
 *
 * 多实例部署下内存即权威值（无 TTL、无每请求查库、无陈旧窗口）。
 */
export class RateLimitConfig {
  private readonly rules: Record<RateLimitBucket, RateLimitRule> = cloneDefaults();

  get(bucket: RateLimitBucket): RateLimitRule {
    return this.rules[bucket];
  }

  listAll(): Array<RateLimitRule & { bucket: RateLimitBucket; isDefault: boolean }> {
    return RATE_LIMIT_BUCKETS.map((b) => {
      const r = this.rules[b];
      const d = DEFAULT_RULES[b];
      return {
        bucket: b,
        ...r,
        isDefault:
          r.maxRequests === d.maxRequests &&
          r.windowSeconds === d.windowSeconds &&
          r.enabled === d.enabled,
      };
    });
  }

  /** v2 无 DB 白名单，恒返回 false（IP 豁免改由路由豁免表 EXEMPT_ROUTES 表达） */
  isAllowed(_ip: string): boolean {
    return false;
  }
}

function cloneDefaults(): Record<RateLimitBucket, RateLimitRule> {
  const out = {} as Record<RateLimitBucket, RateLimitRule>;
  for (const b of RATE_LIMIT_BUCKETS) out[b] = { ...DEFAULT_RULES[b] };
  return out;
}
