import type { Migration } from '../migrate.js';

/**
 * 组织邀请。
 *
 * - token_hash 只存 SHA-256，`UNIQUE` 保证同一明文 token 全库唯一。
 * - 复合 FK `(membership_id, organization_id)` → organization_memberships
 *   `(id, organization_id)`，与 memberships 的 `UNIQUE(id, organization_id)` 呼应。
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
        CONSTRAINT fk_inv_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_inv_membership FOREIGN KEY (membership_id, organization_id)
          REFERENCES organization_memberships(id, organization_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
