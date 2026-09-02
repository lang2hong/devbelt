import type { Migration } from '../migrate.js';

/**
 * 组织、组织订阅和成员关系。
 *
 * 建表顺序按外键依赖：organizations -> organization_subscriptions -> organization_memberships。
 * 约束：
 * - organizations：无 Owner 字段（业务口语中的「组织 Owner」仅指 admin）。
 * - organization_subscriptions：organization_id 唯一；`UNIQUE(id,organization_id)` 供复合外键。
 * - organization_memberships：`UNIQUE(organization_id,user_id)` + `UNIQUE(id,organization_id)`。
 */
export const organizationsMigration: Migration = {
  version: '006_organizations',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        closed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_orgs_status CHECK (status IN ('active', 'closed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_subscriptions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL UNIQUE,
        plan_id BIGINT UNSIGNED NOT NULL,
        seat_limit SMALLINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        entitlement_snapshot JSON NOT NULL,
        period_start_time DATETIME(3) NOT NULL,
        period_end_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_org_sub_id_org (id, organization_id),
        CONSTRAINT chk_org_sub_status CHECK (status IN ('active', 'expired', 'canceled')),
        CONSTRAINT fk_os_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_os_plan FOREIGN KEY (plan_id) REFERENCES organization_plans(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_memberships (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'member',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        invited_by_user_id BIGINT UNSIGNED NULL,
        joined_time DATETIME(3) NULL,
        removed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_membership_org_user (organization_id, user_id),
        UNIQUE KEY uq_membership_id_org (id, organization_id),
        CONSTRAINT chk_membership_role CHECK (role IN ('admin', 'member')),
        CONSTRAINT chk_membership_status CHECK (status IN ('invited', 'active', 'removed')),
        CONSTRAINT fk_member_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
