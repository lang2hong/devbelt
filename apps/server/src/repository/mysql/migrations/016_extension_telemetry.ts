import type { Migration } from '../migrate.js';

/**
 * 016：扩展匿名安装/活跃心跳。
 *
 * - 只记录随机 `install_id` 与首次/最近心跳时间；不存 `user_id`、账号、邮箱或 IP。
 * - `first_seen` 即“首次激活”口径的新安装；`last_seen` 用于 24h/7d/30d 滚动活跃。
 * - 不做卸载推断：本表只增不减，安装总数是累计值。
 *
 * 回滚：
 * ```sql
 * DROP TABLE IF EXISTS extension_installs;
 * DELETE FROM schema_migrations WHERE version = '016_extension_telemetry';
 * ```
 */
export const extensionTelemetryMigration: Migration = {
  version: '016_extension_telemetry',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS extension_installs (
        install_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        first_seen DATETIME(3) NOT NULL,
        last_seen DATETIME(3) NOT NULL,
        first_version VARCHAR(64) NULL,
        last_version VARCHAR(64) NULL,
        os VARCHAR(32) NULL,
        arch VARCHAR(32) NULL,
        is_remote TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (install_id),
        KEY idx_install_first_seen (first_seen),
        KEY idx_install_last_seen (last_seen)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};