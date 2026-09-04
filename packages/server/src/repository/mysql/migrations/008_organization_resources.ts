import type { Migration } from '../migrate.js';

/**
 * 组织目录与资源。
 *
 * 建表顺序：organization_resource_folders -> organization_resources。
 * - 目录表规范名为 `organization_resource_folders`（§4.2 表清单）。
 * - `UNIQUE(id, organization_id)` 保留：服务层用它做「同组织」校验。
 * - 软删除：`delete_time NULL` 表示未删除；资源 `version` 从 1 起，乐观锁锚点。
 *
 * 不建外键（理由见 001 文件头）。这里另有一条**独立于性能**的理由：
 * `created_by_membership_id` / `updated_by_membership_id` 原先挂 `ON DELETE CASCADE`
 * 指向 organization_memberships —— 一旦成员行被物理删除，其创建的资源会被**连带删掉**。
 * 审计归属信息本应比成员关系活得更久，级联删资源是错误语义。
 * 跨组织引用与作者存在性改由服务层在组织行锁内校验。
 *
 * 审计列**刻意指向 membership 而非 user**，不要「修正」成 user_id：
 * `UNIQUE(organization_id, user_id)` 加上 upsertInvited 的 ON DUPLICATE KEY UPDATE
 * 意味着同一个 (组织, 用户) 永远复用同一行、同一 id —— 成员被移除再重新邀请
 * 拿到的还是原来那个 membership_id。因此归属不会因成员生命周期变化而断裂，
 * 而 membership 粒度还额外保留了「以哪个组织身份创建」这一信息。
 */
export const organizationResourcesMigration: Migration = {
  version: '008_organization_resources',
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
        -- parent_id 原由 fk_folder_parent 自动带索引；collectDescendantIds 的递归 CTE
        -- 按 parent_id 逐层展开，缺索引会让每层都全表扫。
        KEY idx_folder_parent (parent_id, organization_id)
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
        CONSTRAINT chk_resource_type CHECK (resource_type IN ('connection_template', 'query'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
