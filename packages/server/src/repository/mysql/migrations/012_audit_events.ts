import type { Migration } from '../migrate.js';

/**
 * 审计事件表（P3 §9）：append-only。
 *
 * 应用运行账号对本表只拥有 INSERT + SELECT，无 UPDATE/DELETE；不暴露修改/删除接口。
 * 字段语义见 §9；任何敏感值（密码/token/hash/密钥/密文/KDF/验证码/支付/DB 凭据/资源内容）绝不入表。
 */
export const auditEventsMigration: Migration = {
  version: '012_audit_events',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        event_time DATETIME(3) NOT NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        actor_role VARCHAR(32) NULL,
        event_type VARCHAR(64) NOT NULL,
        target_type VARCHAR(32) NULL,
        target_id VARCHAR(64) NULL,
        organization_id BIGINT UNSIGNED NULL,
        source_ip VARCHAR(64) NULL,
        request_id VARCHAR(64) NULL,
        result VARCHAR(16) NOT NULL,
        failure_code VARCHAR(64) NULL,
        reason VARCHAR(500) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_audit_time (event_time),
        KEY idx_audit_actor (actor_user_id, event_time),
        KEY idx_audit_type (event_type, event_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};