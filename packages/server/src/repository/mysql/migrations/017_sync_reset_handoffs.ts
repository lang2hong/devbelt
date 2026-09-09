import type { Migration } from '../migrate.js';

/**
 * sync-reset handoff（P3 切片 5 §5.4 / P2 §控制台重置交接协议）。
 *
 * 浏览器认领 sync-reset 邮件流后签发 15 分钟单次 handoffTicket，扩展经深链
 * `vscode://dbclient.sync/reset-after-loss?handoffTicket=` 消费，最终 reset 仅由扩展
 * 提交 newState。本表只存 ticket 的 SHA-256（BINARY(32)），不存明文；完成后的完整
 * StateDto 存 MEDIUMTEXT 供幂等重放。
 *
 * 锁序固定：reset token → handoff（与 P2 消费接口一致，避免跨接口死锁）。
 */
export const syncResetHandoffsMigration: Migration = {
  version: '017_sync_reset_handoffs',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS sync_reset_handoffs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        reset_token_id BIGINT UNSIGNED NOT NULL,
        ticket_hash BINARY(32) NOT NULL,
        request_digest BINARY(32) NULL,
        result_state_dto_json MEDIUMTEXT NULL,
        result_key_epoch VARCHAR(64) NULL,
        result_state_version VARCHAR(64) NULL,
        result_change_sequence VARCHAR(64) NULL,
        status VARCHAR(16) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        consumed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_sync_reset_handoff_ticket_hash (ticket_hash),
        KEY idx_sync_reset_handoff_reset_token (reset_token_id, status, expires_time),
        KEY idx_sync_reset_handoff_user (user_id, status, expires_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};