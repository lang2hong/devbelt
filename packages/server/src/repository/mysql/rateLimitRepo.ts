import { createHash } from 'crypto';
import type { IRateLimitRepo } from '../interfaces.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * 跨实例共享限流计数仓储（固定窗口计数器，见 migration 003）。
 *
 * 原子性来自唯一键 (bucket_key, window_start_time) + `count = count + 1`。
 *
 * 计数与取值合并为**一条**语句，用 `LAST_INSERT_ID(count + 1)` 让 server 把新值
 * 回传到连接态，再由 `insertId` 取出。原实现是「自增」+「SELECT 回读」两条语句，
 * 有两个缺陷：① 两条语句可能落在池里不同连接上，读到的不是本次自增的结果；
 * ② 若清理任务（rateLimitCleanup，默认 5 分钟）正好删掉边界窗口行，回读拿不到行
 * 而返回 0，`hitExceeded` 的 `count > max` 判定为未超限 —— 这一次命中被静默丢弃，
 * 限流失效。单条语句同时消除这两点。
 */
export class MysqlRateLimitRepo implements IRateLimitRepo {
  constructor(private readonly db: () => MysqlDb) {}

  /**
   * 把调用方的逻辑键压成定长存储键。
   *
   * `bucket_key` 是 VARCHAR(255)（migration 003），而逻辑键含用户可控的 email
   * （schema 允许 255 字符）：`login:email:${email}` 超过 243 字符即溢出，严格模式下
   * INSERT 抛 ER_DATA_TOO_LONG。该异常会穿出 hitExceeded → countLoginFailure → login，
   * 于是这次失败**不被计数**、IP 桶也来不及递增 —— 用超长邮箱即可绕过登录限流。
   *
   * 定长化放在 MySQL 仓储而非 service：255 上限是**本实现的存储约束**，
   * 内存假仓储没有这个限制，service 应当只关心逻辑键。
   * 保留冒号前的前缀便于运维辨认桶类型，其余摘要为 64 hex（总长 ≤ 80）。
   *
   * 暴露为 static 是刻意的：`bucket_key` 的存储格式是「逻辑键 → 行」的唯一入口，
   * 直接按逻辑键查 `rate_limit_entries` 会查不到行。测试与排障需要同一套映射，
   * 复制一份 sha256 逻辑必然与实现漂移。
   */
  static storageKey(bucketKey: string): string {
    const sep = bucketKey.indexOf(':');
    const prefix = sep > 0 ? bucketKey.slice(0, sep) : 'k';
    return `${prefix}:${createHash('sha256').update(bucketKey).digest('hex')}`;
  }

  private storageKey(bucketKey: string): string {
    return MysqlRateLimitRepo.storageKey(bucketKey);
  }

  async increment(bucketKey: string, windowStartTime: Date): Promise<number> {
    return this.incrementOn(this.db(), bucketKey, windowStartTime);
  }

  async incrementInTx(exec: Queryable, bucketKey: string, windowStartTime: Date): Promise<number> {
    return this.incrementOn(exec, bucketKey, windowStartTime);
  }

  private async incrementOn(q: Queryable, bucketKey: string, windowStartTime: Date): Promise<number> {
    // 两个分支都要把新计数放进 LAST_INSERT_ID，才能用 insertId 一次取回。
    //
    // 前提：`rate_limit_entries` **不得有 AUTO_INCREMENT 列**（见 migration 003）。
    // 否则 VALUES 分支（该桶首次命中）会用自增 id 覆盖 LAST_INSERT_ID(1)，
    // insertId 返回自增 id 而非计数 1 —— 表里行数一多就超过阈值，首个请求即被误拒。
    const [result] = await q.query<any>(
      `INSERT INTO rate_limit_entries (bucket_key, window_start_time, count)
       VALUES (?, ?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE count = LAST_INSERT_ID(count + 1)`,
      [this.storageKey(bucketKey), windowStartTime],
    );
    return Number(result?.insertId ?? 0);
  }

  async peek(bucketKey: string, windowStartTime: Date): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      'SELECT count FROM rate_limit_entries WHERE bucket_key = ? AND window_start_time = ?',
      [this.storageKey(bucketKey), windowStartTime],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async prune(before: Date): Promise<void> {
    await this.db().query('DELETE FROM rate_limit_entries WHERE window_start_time < ?', [before]);
  }
}