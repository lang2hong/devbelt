import type { Migration } from '../migrate.js';

/**
 * 组织套餐定义表。不含个人配额或 max_members；
 * included_seats 至少 1；allowed_template_database_types 为模板引擎白名单。
 */
export const organizationPlansMigration: Migration = {
  version: '004_organization_plans',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_plans (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(32) NOT NULL UNIQUE,
        name VARCHAR(64) NOT NULL,
        included_seats SMALLINT UNSIGNED NOT NULL,
        max_shared_resources SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        shared_storage_quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        allowed_template_database_types JSON NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_org_plans_seats CHECK (included_seats >= 1),
        CONSTRAINT chk_org_plans_status CHECK (status IN ('active', 'archived'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
