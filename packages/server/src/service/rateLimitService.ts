import { RateLimitedError } from '../domain/errors.js';
import type { IRateLimitRepo } from '../repository/interfaces.js';
import type { Queryable } from '../repository/mysql/db.js';

/**
 * 跨实例共享限流服务（固定窗口计数器）。
 *
 * 窗口起点按 UTC 对齐：`floor(now / windowSeconds) * windowSeconds`。计数走
 * `IRateLimitRepo` 的原子 increment（MySQL 唯一键），跨实例生效（实施规格 §5.2）。
 *
 * 阈值规则（实施规格 §5.2）：
 * - 登录：按规范化 email 与来源 IP 各 15 分钟 5 次**失败**（成功不计数）
 * - 注册：按 IP 每小时 10 次（每次尝试计数）
 * - 邮箱验证重发：按规范化 email 与来源 IP 每小时 3 次（每次尝试计数）
 * - 组织创建：按用户每小时 10 次（每次尝试计数；已认证，不按 IP）
 */
export class RateLimitService {
  constructor(
    private readonly repo: IRateLimitRepo,
    /** 限流总闸（config.rateLimitEnabled）。关闭时不计数、不拒绝。 */
    public readonly enabled = true,
  ) {}

  /** 只读预检：当前窗口计数已达上限则抛 RateLimitedError（用于「失败才计数」端点）。 */
  async assertUnder(bucketKey: string, windowSeconds: number, max: number, now = new Date()): Promise<void> {
    if (!this.enabled || max <= 0) return;
    const count = await this.repo.peek(bucketKey, this.windowStart(now, windowSeconds));
    if (count >= max) {
      throw new RateLimitedError(this.retryAfterSeconds(now, windowSeconds));
    }
  }

  /** 计数一次，返回新 count（用于「每次尝试都计数」的端点）。 */
  async increment(bucketKey: string, windowSeconds: number, now = new Date()): Promise<number> {
    return this.repo.increment(bucketKey, this.windowStart(now, windowSeconds));
  }

  /**
   * 计数并判定是否超限（用于「失败才计数」端点）：原子递增后依据结果决定响应，
   * 避免并发请求都读到旧 count 而全部放行（§5.2）。关闭时恒返回 false。
   */
  async hitExceeded(bucketKey: string, windowSeconds: number, max: number, now = new Date()): Promise<boolean> {
    if (!this.enabled || max <= 0) return false;
    const count = await this.increment(bucketKey, windowSeconds, now);
    return count > max;
  }

  /** 计数并立即判定：超限抛 RateLimitedError。 */
  async hit(bucketKey: string, windowSeconds: number, max: number, now = new Date()): Promise<void> {
    if (!this.enabled || max <= 0) return;
    const count = await this.increment(bucketKey, windowSeconds, now);
    if (count > max) {
      throw new RateLimitedError(this.retryAfterSeconds(now, windowSeconds));
    }
  }

  /**
   * 同一事务内计数并判定（与幂等回执同 Queryable）：限流计数与业务写、回执同滚，
   * 保证仅并发胜者计一次、失败整体回滚（超限抛 RateLimitedError 时该次计数也随事务回滚）。
   */
  async hitInTx(exec: Queryable, bucketKey: string, windowSeconds: number, max: number, now = new Date()): Promise<void> {
    if (!this.enabled || max <= 0) return;
    const count = await this.repo.incrementInTx(exec, bucketKey, this.windowStart(now, windowSeconds));
    if (count > max) {
      throw new RateLimitedError(this.retryAfterSeconds(now, windowSeconds));
    }
  }

  private windowStart(now: Date, windowSeconds: number): Date {
    const s = windowSeconds * 1000;
    return new Date(Math.floor(now.getTime() / s) * s);
  }

  private retryAfterSeconds(now: Date, windowSeconds: number): number {
    const s = windowSeconds * 1000;
    const start = Math.floor(now.getTime() / s) * s;
    return Math.max(1, Math.ceil((start + s - now.getTime()) / 1000));
  }
}