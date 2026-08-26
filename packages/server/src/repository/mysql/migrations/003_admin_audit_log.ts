import type { Migration } from '../migrate.js';

/**
 * 系统级 admin 操作留痕表。
 *
 * v2 Greenfield 的 001 没建此表（设计文档 §4 一度把系统审计归入「外部日志」）。
 * 复审确认：系统 admin 审计（谁把谁提成 admin、谁调了配额）是安全/合规不变量，
 * 不是无界事件表，不应外移。故补回。DDL 与 v1 schema.ts 的 admin_audit_log 同构，
 * 仅校对改为 v2 约定（utf8mb4_0900_ai_ci）。
 *
 * `actor_user_id` 不设外键：用户被删后留痕必须还在。「谁删了这个账号」正是
 * 最需要追溯的一类操作。`detail` 用 TEXT 存 JSON 文本（不参与定期清理：审计
 * 价值随时间增长，且写入极低频）。
 */
export const adminAuditLog: Migration = {
  version: '003_admin_audit_log',
  async up(db): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        actor_user_id BIGINT UNSIGNED NOT NULL,
        actor_email VARCHAR(190) NULL,
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(32) NOT NULL,
        target_id VARCHAR(64) NOT NULL,
        detail TEXT NULL,
        ip VARCHAR(45) NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_aal_time (create_time),
        KEY idx_aal_actor (actor_user_id, create_time),
        KEY idx_aal_target (target_type, target_id, create_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
