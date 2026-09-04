import type { Migration } from '../migrate.js';

/**
 * 跨实例共享限流计数表（固定窗口计数器）。
 *
 * 限流计数必须保存在所有服务实例共享的存储中（实施规格 §5.2），故独立建表；
 * 表名见规格 §4.2 限流条目。
 *
 * 固定窗口语义：`window_start_time = floor(now / windowSeconds) * windowSeconds`。
 * 计数通过 `INSERT ... ON DUPLICATE KEY UPDATE count = LAST_INSERT_ID(count + 1)`
 * 原子递增，并用 `insertId` 把新计数取回（一条语句完成「递增 + 读取」）。
 * 过期桶由受控清理任务删除，不依赖请求触发。
 *
 * **主键刻意用 `(bucket_key, window_start_time)`，不设 AUTO_INCREMENT 代理键。**
 * 这不是风格选择，而是上面那条语句的正确性前提：MySQL 在 INSERT 走 VALUES 分支
 * （即该桶的首次命中）时，会用新行的 AUTO_INCREMENT 值**覆盖**
 * `LAST_INSERT_ID(1)` 写入的值，于是 `insertId` 返回的是自增 id 而不是计数 1。
 * 表里一旦积累了若干行，自增 id 就会超过阈值（如 ORG_CREATE_MAX=10），
 * 导致**首次请求即被误判超限**。去掉 AUTO_INCREMENT 列后，VALUES 分支不再产生
 * 自增值，`insertId` 恒等于 `LAST_INSERT_ID()` 显式设置的计数。
 */
export const rateLimitMigration: Migration = {
  version: '003_rate_limit',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_entries (
        bucket_key VARCHAR(255) NOT NULL,
        window_start_time DATETIME(3) NOT NULL,
        count INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (bucket_key, window_start_time),
        KEY idx_rate_window (window_start_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
