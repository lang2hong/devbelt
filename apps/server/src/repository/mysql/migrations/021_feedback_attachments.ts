import type { Migration } from '../migrate.js';

/**
 * 021：反馈附件（截图）。
 *
 * 图片不落数据库，只存元数据；文件由服务端写到 `DEVBELT_DB_FEEDBACK_UPLOAD_DIR`
 * （默认 `<cwd>/uploads/feedback`，0700），文件名随机、不暴露原始名。
 *
 * - 只允许 PNG / JPEG / WebP / GIF（mime 由**文件头魔数**校验后写入）。
 * - 单条反馈最多 3 张、每张 ≤2 MiB（业务层限制）。
 * - 管理后台通过鉴权路由读取，不做公开静态托管。
 *
 * 回滚：
 * ```sql
 * DROP TABLE IF EXISTS feedback_attachments;
 * DELETE FROM schema_migrations WHERE version = '021_feedback_attachments';
 * ```
 */
export const feedbackAttachmentsMigration: Migration = {
  version: '021_feedback_attachments',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS feedback_attachments (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        feedback_id BIGINT UNSIGNED NOT NULL,
        storage_name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        file_name VARCHAR(200) NOT NULL,
        mime VARCHAR(32) NOT NULL,
        size_bytes INT UNSIGNED NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_feedback_attachment_storage (storage_name),
        KEY idx_feedback_attachments_feedback (feedback_id, id),
        CONSTRAINT fk_feedback_attachment_feedback FOREIGN KEY (feedback_id)
          REFERENCES user_feedback(id) ON DELETE CASCADE,
        CONSTRAINT chk_feedback_attachment_mime
          CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
