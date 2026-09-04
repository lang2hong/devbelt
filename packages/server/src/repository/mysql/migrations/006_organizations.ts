import type { Migration } from '../migrate.js';

/**
 * 组织、组织订阅和成员关系。
 *
 * 建表顺序：organizations -> organization_subscriptions -> organization_memberships。
 * 约束：
 * - organizations：无 Owner 字段（业务口语中的「组织 Owner」仅指 admin）。
 * - organization_subscriptions：organization_id 唯一；`UNIQUE(id,organization_id)` 保留，
 *   供服务层做「同组织」复合条件校验（不再用于数据库级复合外键）。
 * - organization_memberships：`UNIQUE(organization_id,user_id)` + `UNIQUE(id,organization_id)`
 *   + `KEY(user_id)`。
 *
 * 本迁移不再建任何外键，理由见 001 文件头。特别注意：`fk_member_org` 这个名字
 * 曾与既有库里的同名约束冲突，导致本迁移无法应用 —— FK 名在库内全局唯一是个
 * 真实的运维负担。删 FK 后已按需补回等价索引（idx_org_sub_plan、idx_membership_user）。
 */
export const organizationsMigration: Migration = {
  version: '006_organizations',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        -- 「已关闭」只用 delete_time 一列表达（NULL = active）。
        -- 原先是 status='closed' + closed_time 两列编码同一事实，没有任何约束阻止
        -- 出现 status='active' 配非空 closed_time 的矛盾行。关闭是终态、不可重开，
        -- 因此它就是一次软删除。DTO 里的 status/closedTime 由 mapper 派生，API 不变。
        delete_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
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
        -- plan_id 原由 fk_os_plan 自动带索引，删 FK 后显式保留。
        KEY idx_org_sub_plan (plan_id),
        CONSTRAINT chk_org_sub_status CHECK (status IN ('active', 'expired', 'canceled'))
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
        -- 关键索引：uq_membership_org_user 的前导列是 organization_id，无法服务
        -- 「按 user_id 查我加入的所有组织」。该访问路径原先靠 fk_member_user 的
        -- 自动索引，删 FK 后必须显式补，否则退化为全表扫。
        KEY idx_membership_user (user_id),
        CONSTRAINT chk_membership_role CHECK (role IN ('admin', 'member')),
        CONSTRAINT chk_membership_status CHECK (status IN ('invited', 'active', 'removed')),
        -- status 与 removed_time 必须一致，杜绝「status='active' 却有 removed_time」
        -- 这类矛盾行。此前只靠仓储代码成对写入，DB 层无任何保障。
        --
        -- 注意这里刻意**不**把 removed 改成 delete_time：status 是一个三态状态机
        -- （invited -> active -> removed），removed 是其中一态而非附加标记。保留
        -- status 的额外好处是查询自排除：status='active' 不可能误含已移除成员。
        -- 若改成 delete_time，席位计数、admin 计数等十来处查询都得记着多加一个
        -- delete_time IS NULL，漏一处就是把已移除成员算进配额。
        CONSTRAINT chk_membership_removed CHECK (
          (status = 'removed' AND removed_time IS NOT NULL)
          OR (status <> 'removed' AND removed_time IS NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
