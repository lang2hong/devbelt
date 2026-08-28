import type { IRateLimitRepo } from '../interfaces.js';
import type { MysqlDb } from './db.js';

/**
 * 跨实例共享限流计数仓储（固定窗口计数器，见 migration 003）。
 *
 * 原子性来自唯一键 (bucket_key, window_start_time) + `count = count + 1`：
 * 增量一定落账。递增后再读一次 count 返回当前值 —— 两步之间若另有并发递增，
 * 读数只可能略低于瞬时真实值，但不会漏计数（限流只用于防暴力，该近似可接受；
 * 单线程测试下读数精确）。
 */
export class MysqlRateLimitRepo implements IRateLimitRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async increment(bucketKey: string, windowStartTime: Date): Promise<number> {
    await this.db().query(
      `INSERT INTO rate_limit_entries (bucket_key, window_start_time, count)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [bucketKey, windowStartTime],
    );
    const [rows] = await this.db().query<any[]>(
      'SELECT count FROM rate_limit_entries WHERE bucket_key = ? AND window_start_time = ?',
      [bucketKey, windowStartTime],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async peek(bucketKey: string, windowStartTime: Date): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      'SELECT count FROM rate_limit_entries WHERE bucket_key = ? AND window_start_time = ?',
      [bucketKey, windowStartTime],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async prune(before: Date): Promise<void> {
    await this.db().query('DELETE FROM rate_limit_entries WHERE window_start_time < ?', [before]);
  }
}