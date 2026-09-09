import type { Migration } from '../migrate.js';

/**
 * 幂等回执表（P3 §6.1）。
 *
 * 唯一键 (actor_user_id, session_id, method, normalized_path, idempotency_key) 是并发
 * 去重的核心：首次请求在业务事务内 INSERT `processing` 回执，业务写 + 审计完成后置
 * `completed`；同键并发插入被唯一键串行化（后到达事务阻塞至前者提交后触发重复键）。
 * 回执在线保留 24 小时（retentionCleanup 清理）；关闭组织回执保留 30 天（切片 3 组织写，
 * 见 §6.1）；订阅调整/禁用用户回执的 30 天例外属切片 4。
 * response_body 存首次响应的规范 JSON，供同键同摘要重放（不重复业务写、不重复审计）。
 */
export const idempotencyReceiptsMigration: Migration = {
  version: '014_idempotency_receipts',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS idempotency_receipts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        actor_user_id BIGINT UNSIGNED NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        method VARCHAR(8) NOT NULL,
        normalized_path VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(48) NOT NULL,
        request_digest BINARY(32) NOT NULL,
        status ENUM('processing','completed') NOT NULL DEFAULT 'processing',
        http_status SMALLINT NULL,
        response_body MEDIUMTEXT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        expires_time DATETIME(3) NOT NULL,
        UNIQUE KEY uq_idempotency (actor_user_id, session_id, method, normalized_path, idempotency_key),
        KEY idx_idempotency_expires (expires_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};