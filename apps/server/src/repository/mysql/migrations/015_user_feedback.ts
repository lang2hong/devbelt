import type { Migration } from '../migrate.js';

/**
 * 015：用户反馈表。
 *
 * - 允许匿名提交（user_id 可空）；登录用户提交时记录 user_id，便于运营回访。
 * - `install_id` 是扩展端生成的随机匿名安装标识（不含任何 PII），仅用于同一安装的
 *   反馈聚合与限流，不做跨站追踪。
 * - 状态机：new → triaged → done / rejected（只允许前进/回退，不做删除，保留历史）。
 *
 * 回滚：
 * ```sql
 * DROP TABLE IF EXISTS user_feedback;
 * DELETE FROM schema_migrations WHERE version = '015_user_feedback';
 * ```
 */
export const userFeedbackMigration: Migration = {
  version: '015_user_feedback',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_feedback (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NULL,
        install_id VARCHAR(64) NULL,
        category VARCHAR(16) NOT NULL,
        content TEXT NOT NULL,
        contact VARCHAR(200) NULL,
        app_version VARCHAR(64) NULL,
        os VARCHAR(100) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'new',
        admin_note VARCHAR(1000) NULL,
        source_ip VARCHAR(64) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_feedback_status_time (status, create_time),
        KEY idx_feedback_user (user_id, create_time),
        KEY idx_feedback_install (install_id, create_time),
        CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_feedback_status CHECK (status IN ('new', 'triaged', 'done', 'rejected')),
        CONSTRAINT chk_feedback_category CHECK (category IN ('bug', 'feature', 'other'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};