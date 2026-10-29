import type { Migration } from '../migrate.js';

/**
 * 018：扩展每日活跃（按安装去重）。
 *
 * 016 只存了 `last_seen`，无法还原“某天有多少安装活跃”。本表每个安装每天最多一行：
 * - 心跳写 `INSERT IGNORE`，同一天重试/多窗口不会重复；
 * - 查询按 `active_day` 分组得到日活；
 * - 不存任何新增个人信息，仍然只是匿名 `install_id`。
 *
 * 历史无法回填：本表从部署时开始记，之前的活跃只能靠 016 的 24h/7d/30d 快照。
 *
 * 回滚：
 * ```sql
 * DROP TABLE IF EXISTS extension_active_days;
 * DELETE FROM schema_migrations WHERE version = '018_extension_active_days';
 * ```
 */
export const extensionActiveDaysMigration: Migration = {
  version: '018_extension_active_days',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS extension_active_days (
        install_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        active_day DATE NOT NULL,
        PRIMARY KEY (install_id, active_day),
        KEY idx_active_day (active_day)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};