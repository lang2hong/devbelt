import type { Migration } from '../migrate.js';

/**
 * V3 组织目录与资源（切片 4，§4.1/§4.2/§4.3）。
 *
 * 建表按外键依赖：organization_resource_folders -> organization_resources。
 * - 目录表规范名为 `organization_resource_folders`（§4.1 14 表清单）。
 * - 目录/作者均使用同组织复合外键；`UNIQUE(id, organization_id)` 供复合 FK 引用。
 * - 软删除：`delete_time NULL` 表示未删除；资源 `version` 从 1 起，乐观锁锚点。
 * - 全部 ON DELETE CASCADE：Phase 1 不物理删除（组织 close 软、成员 remove 软），
 *   该级联仅为「物理删除父行」时的安全网，正常不触发。
 */
export const resourcesV3: Migration = {
  version: '008_organization_resources_v3',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_resource_folders (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        parent_id BIGINT UNSIGNED NULL,
        name VARCHAR(200) NOT NULL,
        delete_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_folder_id_org (id, organization_id),
        KEY idx_folder_org (organization_id),
        CONSTRAINT fk_folder_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_folder_parent FOREIGN KEY (parent_id, organization_id)
          REFERENCES organization_resource_folders(id, organization_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_resources (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        folder_id BIGINT UNSIGNED NULL,
        resource_type VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        content JSON NOT NULL,
        version INT NOT NULL,
        created_by_membership_id BIGINT UNSIGNED NOT NULL,
        updated_by_membership_id BIGINT UNSIGNED NULL,
        delete_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_resource_id_org (id, organization_id),
        KEY idx_resource_org (organization_id),
        KEY idx_resource_folder (folder_id),
        CONSTRAINT chk_resource_type CHECK (resource_type IN ('connection_template', 'query')),
        CONSTRAINT fk_resource_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_resource_folder FOREIGN KEY (folder_id, organization_id)
          REFERENCES organization_resource_folders(id, organization_id) ON DELETE CASCADE,
        CONSTRAINT fk_resource_created_by FOREIGN KEY (created_by_membership_id, organization_id)
          REFERENCES organization_memberships(id, organization_id) ON DELETE CASCADE,
        CONSTRAINT fk_resource_updated_by FOREIGN KEY (updated_by_membership_id, organization_id)
          REFERENCES organization_memberships(id, organization_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};