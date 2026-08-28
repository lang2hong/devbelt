import type { Migration } from '../migrate.js';

/**
 * V3 跨实例共享限流计数表（固定窗口计数器）。
 *
 * 实施规格 §4.5 要求「限流计数必须保存在所有服务实例共享的存储中」，但 §4.1
 * 的表清单未给出该表 —— 本表为对该空白的落地补充（见规格 §4.1/4.2 限流表条目）。
 *
 * 固定窗口语义：`window_start_time = floor(now / windowSeconds) * windowSeconds`。
 * 计数通过 `INSERT ... ON DUPLICATE KEY UPDATE count = count + 1`（唯一键
 * `(bucket_key, window_start_time)`）原子递增，返回值即当前窗口计数。
 * 过期桶由受控清理任务删除，不依赖请求触发。
 */
export const rateLimitTableV3: Migration = {
  version: '003_rate_limit_v3',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_entries (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        bucket_key VARCHAR(255) NOT NULL,
        window_start_time DATETIME(3) NOT NULL,
        count INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_rate_bucket_window (bucket_key, window_start_time),
        KEY idx_rate_window (window_start_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};