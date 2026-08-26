import type { Migration } from '../migrate.js';

/**
 * v2 初始 schema（16 张核心业务表，不含 schema_migrations —— 由 runner 自建）。
 *
 * 对应设计文档 docs/数据库设计v2.md §3：
 * - 全局约定：BIGINT 自增主键、create_time/update_time、软删 delete_time、
 *   utf8mb4_0900_ai_ci、金额 DECIMAL(10,2)。
 * - 组织是计费主体：subscriptions/orders/invoices/seats 全挂 organizations。
 * - 外键策略：主实体表建 FK（CASCADE）；留痕/日志/审计表不建 FK。
 *
 * 建表顺序按 FK 依赖自底向上（父表先建），保证外键可引用。
 */
export const initialSchemaV2: Migration = {
  version: '001_initial_schema_v2',
  async up(db): Promise<void> {
    // ── 身份 / 组织 ──────────────────────────────────────────────

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'user',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        last_login_time DATETIME NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        delete_time DATETIME NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(16) NOT NULL DEFAULT 'personal',
        owner_user_id BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        delete_time DATETIME NULL,
        KEY idx_org_owner (owner_user_id),
        CONSTRAINT fk_org_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'member',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        delete_time DATETIME NULL,
        UNIQUE KEY uq_membership (organization_id, user_id),
        UNIQUE KEY uq_membership_id_org (id, organization_id),
        CONSTRAINT chk_membership_role CHECK (role IN ('admin', 'member')),
        CONSTRAINT fk_member_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 认证 / 设备 ──────────────────────────────────────────────

    await db.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        device_id VARCHAR(64) NULL,
        device_name VARCHAR(120) NULL,
        user_agent VARCHAR(255) NULL,
        ip VARCHAR(45) NULL,
        expires_time DATETIME NOT NULL,
        revoke_time DATETIME NULL,
        last_used_time DATETIME NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_rt_user (user_id, revoke_time, expires_time),
        KEY idx_rt_expires (expires_time),
        CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        device_id VARCHAR(64) NOT NULL,
        hostname VARCHAR(120) NULL,
        os VARCHAR(32) NULL,
        os_version VARCHAR(64) NULL,
        arch VARCHAR(16) NULL,
        app_name VARCHAR(64) NULL,
        app_version VARCHAR(32) NULL,
        remote_name VARCHAR(32) NULL,
        vs_machine_id VARCHAR(64) NULL,
        language VARCHAR(16) NULL,
        timezone VARCHAR(64) NULL,
        last_seen_time DATETIME NULL,
        revoke_time DATETIME NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_device_user (user_id, device_id),
        CONSTRAINT fk_device_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 计费 ────────────────────────────────────────────────────

    await db.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(16) NOT NULL UNIQUE,
        name VARCHAR(40) NOT NULL,
        price_month DECIMAL(10,2) NOT NULL DEFAULT 0,
        price_year DECIMAL(10,2) NOT NULL DEFAULT 0,
        seat_price_month DECIMAL(10,2) NULL,
        seat_price_year DECIMAL(10,2) NULL,
        included_seats SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        per_seat_max_devices SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        per_user_max_private_connections SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        per_user_max_open_connections SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        per_user_private_sync_quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        per_user_sync_version_retention SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        per_user_history_retention_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        org_max_shared_connections SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        org_shared_sync_quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        org_max_members SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        features INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        plan_id BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL,
        period_start_time DATETIME NULL,
        period_end_time DATETIME NULL,
        trial_end_time DATETIME NULL,
        cancel_time DATETIME NULL,
        provider VARCHAR(32) NOT NULL DEFAULT 'manual',
        external_id VARCHAR(191) NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_sub_org (organization_id),
        UNIQUE KEY uq_sub_provider_external (provider, external_id),
        KEY idx_sub_status_period (status, period_end_time),
        CONSTRAINT fk_sub_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_sub_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        subscription_id BIGINT UNSIGNED NULL,
        plan_id BIGINT UNSIGNED NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
        status VARCHAR(16) NOT NULL,
        provider VARCHAR(32) NOT NULL,
        external_id VARCHAR(191) NULL,
        seat_delta INT NOT NULL DEFAULT 0,
        period_months TINYINT UNSIGNED NOT NULL DEFAULT 1,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_order_org (organization_id, create_time),
        UNIQUE KEY uq_order_provider_external (provider, external_id),
        CONSTRAINT fk_order_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_order_sub FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL,
        CONSTRAINT fk_order_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS seats (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        subscription_id BIGINT UNSIGNED NOT NULL,
        organization_id BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        delete_time DATETIME NULL,
        KEY idx_seat_org (organization_id, status),
        CONSTRAINT fk_seat_sub FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
        CONSTRAINT fk_seat_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 共享资源只保存不含密码/私钥的模板与查询；encrypted_data 是服务端静态加密载荷，
    // 不是用户级 E2E 密文。created_by/update_by 不设 FK，成员离开后资源与审计来源仍可追溯。
    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_resources (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        resource_type VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        access_scope VARCHAR(16) NOT NULL DEFAULT 'organization',
        encrypted_data MEDIUMTEXT NOT NULL,
        created_by_user_id BIGINT UNSIGNED NOT NULL,
        updated_by_user_id BIGINT UNSIGNED NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        delete_time DATETIME NULL,
        UNIQUE KEY uq_resource_id_org (id, organization_id),
        KEY idx_resource_org_type (organization_id, resource_type, delete_time),
        CONSTRAINT chk_resource_scope CHECK (access_scope IN ('organization', 'restricted')),
        CONSTRAINT fk_resource_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 仅 access_scope='restricted' 的资源需要显式授权。复合外键保证资源与成员属于同一组织，
    // 不能把 A 组织的资源错误授权给 B 组织成员。
    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_resource_permissions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        resource_id BIGINT UNSIGNED NOT NULL,
        membership_id BIGINT UNSIGNED NOT NULL,
        permission VARCHAR(16) NOT NULL DEFAULT 'read',
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_resource_permission (resource_id, membership_id),
        KEY idx_resource_permission_member (membership_id),
        CONSTRAINT chk_resource_permission CHECK (permission IN ('read', 'write')),
        CONSTRAINT fk_resource_permission_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT fk_resource_permission_resource FOREIGN KEY (resource_id, organization_id)
          REFERENCES organization_resources(id, organization_id) ON DELETE CASCADE,
        CONSTRAINT fk_resource_permission_member FOREIGN KEY (membership_id, organization_id)
          REFERENCES memberships(id, organization_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 组织级审计独立于系统管理员审计：admin_audit_log 记录后台管理行为，
    // 本表记录成员、共享资源和权限变更。刻意不设外键，保留主体删除后的证据。
    await db.query(`
      CREATE TABLE IF NOT EXISTS organization_audit_log (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        action VARCHAR(64) NOT NULL,
        resource_type VARCHAR(32) NULL,
        resource_id BIGINT UNSIGNED NULL,
        detail TEXT NULL,
        ip VARCHAR(45) NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_org_audit_time (organization_id, create_time),
        KEY idx_org_audit_resource (organization_id, resource_type, resource_id, create_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        provider VARCHAR(32) NOT NULL,
        event_key VARCHAR(191) NOT NULL,
        detail TEXT NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_we_provider_key (provider, event_key),
        KEY idx_we_time (create_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 同步（E2E 密文）─────────────────────────────────────────

    await db.query(`
      CREATE TABLE IF NOT EXISTS sync_sections (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        section VARCHAR(16) NOT NULL,
        encrypted_data MEDIUMTEXT NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ss_user_section (user_id, section),
        CONSTRAINT fk_ss_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS sync_section_versions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        section VARCHAR(16) NOT NULL,
        version INT UNSIGNED NOT NULL,
        encrypted_data MEDIUMTEXT NOT NULL,
        data_bytes INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_sv_user_section (user_id, section, version),
        CONSTRAINT fk_sv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS connection_meta (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        conn_id VARCHAR(64) NOT NULL,
        type VARCHAR(32) NOT NULL,
        name VARCHAR(200) NULL,
        group_name VARCHAR(100) NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        client_created_at BIGINT NULL,
        client_updated_at BIGINT NULL,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        delete_time DATETIME NULL,
        UNIQUE KEY uq_cm_user_conn (user_id, conn_id),
        CONSTRAINT fk_cm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

  },
};
