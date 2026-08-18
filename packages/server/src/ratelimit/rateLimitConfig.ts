import type { IRateLimitRepo } from '../repository/interfaces.js';
import {
  DEFAULT_RULES,
  RATE_LIMIT_BUCKETS,
  type RateLimitBucket,
  type RateLimitRule,
} from './rules.js';

export interface RateLimitConfigLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * 限流配置的内存权威值。
 *
 * ## 为什么不用环境变量
 *
 * 限流阈值恰恰是那种「半夜发现锁错人了要立刻放宽」的东西。环境变量要重启，
 * 重启是最差的介质。
 *
 * ## 为什么不是纯 DB
 *
 * 纯 DB 意味着要么每请求查库（限流本身成了负担），要么加 TTL 缓存（引入
 * 陈旧窗口）。而且 DB 抖动时限流就没了依据。
 *
 * ## 实际做法：代码默认值 + DB 覆盖 + 内存权威
 *
 * - 启动时 `reload()` 把 DB 的覆盖行合并到内存
 * - 后台改动时同时写 DB 和内存
 * - 读永远只读内存
 *
 * 单实例部署下内存就是权威值：没有 TTL、没有每请求查库、没有跨进程失效，
 * 也就没有陈旧窗口。DB 只是重启后的持久化介质。
 *
 * 多实例部署会打破这个假设（A 实例改了，B 实例不知道）。真到那一步应该
 * 换 Redis store，而不是给这里加轮询。
 */
export class RateLimitConfig {
  private rules: Record<RateLimitBucket, RateLimitRule>;
  private allowlist: Set<string> = new Set();

  constructor(
    private readonly repo: IRateLimitRepo | undefined,
    private readonly log: RateLimitConfigLogger = { warn: () => {} },
  ) {
    this.rules = cloneDefaults();
  }

  /**
   * 从 DB 重载覆盖行与白名单。
   *
   * 读失败不抛：限流沿用代码默认值继续工作，只记一条 warn。让限流因为
   * DB 抖动而失效，比用一套不那么精确的阈值糟糕得多。
   */
  async reload(): Promise<void> {
    if (!this.repo) return;
    try {
      const rows = await this.repo.listRules();
      const merged = cloneDefaults();
      for (const row of rows) {
        // DB 里可能残留已废弃的桶名（比如代码改了桶划分），忽略它们
        if (!isBucket(row.bucket)) continue;
        merged[row.bucket] = {
          ...merged[row.bucket],
          maxRequests: row.maxRequests,
          windowSeconds: row.windowSeconds,
          enabled: row.enabled,
        };
      }
      this.rules = merged;
    } catch (err) {
      this.log.warn({ err }, 'failed to load rate limit rules; using code defaults');
    }
    try {
      const list = await this.repo.listAllowlist();
      this.allowlist = new Set(list.map((r) => r.ip));
    } catch (err) {
      this.log.warn({ err }, 'failed to load rate limit allowlist; treating it as empty');
    }
  }

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

  /** 写 DB 并立即更新内存。DB 写失败则抛出，内存不动（保持一致） */
  async update(
    bucket: RateLimitBucket,
    patch: { maxRequests?: number; windowSeconds?: number; enabled?: boolean },
  ): Promise<void> {
    const next: RateLimitRule = {
      ...this.rules[bucket],
      ...(patch.maxRequests !== undefined ? { maxRequests: patch.maxRequests } : {}),
      ...(patch.windowSeconds !== undefined ? { windowSeconds: patch.windowSeconds } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    if (this.repo) {
      await this.repo.upsertRule({
        bucket,
        maxRequests: next.maxRequests,
        windowSeconds: next.windowSeconds,
        enabled: next.enabled,
      });
    }
    this.rules[bucket] = next;
  }

  isAllowed(ip: string): boolean {
    return this.allowlist.has(ip);
  }

  listAllowlist(): string[] {
    return [...this.allowlist];
  }

  async addAllowlist(ip: string, note?: string): Promise<void> {
    if (this.repo) await this.repo.addAllowlist(ip, note);
    this.allowlist.add(ip);
  }

  async removeAllowlist(ip: string): Promise<void> {
    if (this.repo) await this.repo.removeAllowlist(ip);
    this.allowlist.delete(ip);
  }
}

function cloneDefaults(): Record<RateLimitBucket, RateLimitRule> {
  const out = {} as Record<RateLimitBucket, RateLimitRule>;
  for (const b of RATE_LIMIT_BUCKETS) out[b] = { ...DEFAULT_RULES[b] };
  return out;
}

function isBucket(v: string): v is RateLimitBucket {
  return (RATE_LIMIT_BUCKETS as readonly string[]).includes(v);
}
