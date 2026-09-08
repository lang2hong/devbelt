import type { Migration } from '../migrate.js';

/**
 * 一次性邮件链接（mail-flow）表（P3 §5.1）。
 *
 * 只存 hash：target_token_hash / nonce_hash 均为 BINARY(32)（SHA-256 原始字节）。
 * type 决定目标 token 表；切片 1 只启用 verify-email。
 * 唯一索引 nonce_hash 保证 Cookie nonce 可唯一定位；target/user 查询索引服务清理与幂等。
 */
export const mailFlowsMigration: Migration = {
  version: '011_mail_flows',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS mail_flows (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        type ENUM('verify-email','accept-invitation','sync-reset') NOT NULL,
        target_token_hash BINARY(32) NOT NULL,
        target_record_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NULL,
        nonce_hash BINARY(32) NOT NULL,
        status ENUM('issued','consumed','expired','revoked') NOT NULL DEFAULT 'issued',
        expires_time DATETIME(3) NOT NULL,
        consumed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_mail_flows_nonce (nonce_hash),
        KEY idx_mail_flows_target (target_token_hash, status, expires_time),
        KEY idx_mail_flows_user (user_id, status, expires_time),
        -- 清理按到期/消费时间分批删除，须有以这两列为前导的索引，否则全表扫描（公开认领
        -- 会对未知 token 也建行，表可被外部增长放大）。
        KEY idx_mail_flows_expires (expires_time),
        KEY idx_mail_flows_consumed (consumed_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};