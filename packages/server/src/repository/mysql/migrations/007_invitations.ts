import type { Migration } from '../migrate.js';

/**
 * 组织邀请。
 *
 * - token_hash 只存 SHA-256，`UNIQUE` 保证同一明文 token 全库唯一。
 * - `(membership_id, organization_id)` 的「同组织」约束改由服务层在组织行锁内校验
 *   （原为复合外键，连同其它 FK 一并移除，理由见 001 文件头）。
 * - accepted_time / revoked_time NULL 表示「未接受 / 未撤销」；终态（accepted 或
 *   revoked）不删除行（保留审计线索）。
 */
export const invitationsMigration: Migration = {
  version: '007_invitations',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_invitations (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        membership_id BIGINT UNSIGNED NOT NULL,
        email VARCHAR(255) NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_time DATETIME(3) NOT NULL,
        accepted_time DATETIME(3) NULL,
        revoked_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_invitation_membership (membership_id),
        -- organization_id 原由 fk_inv_org 自动带索引；listActiveByOrganization /
        -- findExpiredOrganizationIds / expireByOrganization 都按它过滤。
        KEY idx_invitation_org (organization_id, expires_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
