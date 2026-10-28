import type { Migration } from '../migrate.js';
import { addOrVerify } from './migrationGuards.js';

/**
 * 017：反馈站内回复。
 *
 * - `user_feedback.reply_key_hash`：扩展生成的随机 replyKey 的 SHA-256（只存哈希）。
 *   **逐行**存储：扩展凭 `install_id + replyKey` 只能读到哈希匹配的行，知道别人的
 *   install_id 也无法读取或劫持其线程。
 * - `feedback_replies`：管理员回复。邮件为可选副作用，在事务提交后发送，
 *   `email_status` 记录结果（skipped / pending / sent / failed）。
 *
 * 回滚：
 * ```sql
 * DROP TABLE IF EXISTS feedback_replies;
 * ALTER TABLE user_feedback DROP INDEX idx_feedback_install_key, DROP COLUMN reply_key_hash;
 * DELETE FROM schema_migrations WHERE version = '017_feedback_replies';
 * ```
 */
export const feedbackRepliesMigration: Migration = {
  version: '017_feedback_replies',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    // 列：isDuplicateObject 不识别「列已存在」，先查 information_schema 保证重跑幂等。
    const [cols] = (await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'user_feedback' AND column_name = 'reply_key_hash' LIMIT 1`,
    )) as [Array<unknown>, unknown];
    if (cols.length === 0) {
      await db.query(
        `ALTER TABLE user_feedback
           ADD COLUMN reply_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER install_id`,
      );
    }

    await addOrVerify(
      db,
      `ALTER TABLE user_feedback ADD INDEX idx_feedback_install_key (install_id, reply_key_hash)`,
      `SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'user_feedback' AND index_name = 'idx_feedback_install_key' LIMIT 1`,
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS feedback_replies (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        feedback_id BIGINT UNSIGNED NOT NULL,
        admin_user_id BIGINT UNSIGNED NULL,
        body VARCHAR(4000) NOT NULL,
        email_status VARCHAR(16) NOT NULL DEFAULT 'skipped',
        email_to VARCHAR(255) NULL,
        email_error VARCHAR(200) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_reply_feedback (feedback_id, id),
        CONSTRAINT fk_reply_feedback FOREIGN KEY (feedback_id) REFERENCES user_feedback(id) ON DELETE CASCADE,
        CONSTRAINT fk_reply_admin FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_reply_email_status CHECK (email_status IN ('skipped', 'pending', 'sent', 'failed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
