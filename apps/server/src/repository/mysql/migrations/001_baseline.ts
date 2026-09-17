import type { Migration } from '../migrate.js';

/**
 * 单一基线 schema（开发阶段 squash：原 001–024 合并为本文件）。
 *
 * 破坏性：先 DROP 全部应用表再重建。允许，因为当前为开发阶段、数据可清空。
 * 迁移 runner 的 schema_migrations 账本保留，但本文件会清空其历史行，仅留下本基线。
 *
 * ## 相对旧 schema 的结构性变化
 * - 套餐统一为 `plans` + 纵表 `plan_feature_defs` / `plan_feature_values`（原 personal_plans
 *   / organization_plans 双表与固定特性列作废）。
 * - 权益**派生**：删除 `*_subscriptions.entitlement_snapshot`，订阅只引用 plan。
 * - 价格入库：`plans.price_cents` + `billing_unit`。
 * - 组织生命周期统一为 `status('active','closed') + closed_time`（去 delete_time）。
 * - 关键链补外键；高写入追加表（audit_events / sync_* / payment_callback_nonces）不补。
 * - 状态列一律 VARCHAR + CHECK（去原生 ENUM）；补清理/查询索引；删写而不读列。
 *
 * ## 外键顺序
 * 先 DROP 全部（FOREIGN_KEY_CHECKS=0），再按依赖顺序建表。
 */

/** 旧库全部应用表（不含 schema_migrations）。 */
const LEGACY_TABLES = [
  'payment_callback_nonces', 'invoices', 'payments', 'orders', 'sync_reset_handoffs',
  'idempotency_receipts', 'audit_events', 'mail_flows', 'personal_sync_reset_tokens',
  'personal_sync_mutations', 'personal_sync_nonces', 'personal_connection_meta',
  'personal_sync_state', 'organization_resources', 'organization_resource_folders',
  'organization_invitations', 'organization_memberships', 'organization_subscriptions',
  'organizations', 'organization_plans', 'rate_limit_entries', 'refresh_tokens',
  'devices', 'email_verification_tokens', 'personal_subscriptions', 'personal_plans',
  'users',
] as const;

interface FeatureSeed {
  key: string;
  kind: 'personal' | 'organization' | 'both';
  labelEn: string;
  labelZh: string;
  valueType: 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';
  unit: string | null;
  sortOrder: number;
}

const FEATURE_DEFS: readonly FeatureSeed[] = [
  { key: 'allowedDatabaseTypes', kind: 'personal', labelEn: 'Databases', labelZh: '支持的数据库', valueType: 'stringList', unit: null, sortOrder: 10 },
  { key: 'maxSavedConnections', kind: 'personal', labelEn: 'Saved connections', labelZh: '本机保存连接数', valueType: 'number', unit: 'count', sortOrder: 20 },
  { key: 'maxConnectionMetas', kind: 'personal', labelEn: 'Cloud connection metadata', labelZh: '云端连接元数据', valueType: 'number', unit: 'count', sortOrder: 30 },
  { key: 'syncStorageBytes', kind: 'personal', labelEn: 'Cloud sync storage', labelZh: '云端同步空间', valueType: 'bytes', unit: 'bytes', sortOrder: 40 },
  { key: 'allowConnectionImport', kind: 'personal', labelEn: 'Import connections', labelZh: '导入连接配置', valueType: 'bool', unit: null, sortOrder: 50 },
  { key: 'maxDevices', kind: 'personal', labelEn: 'Devices', labelZh: '设备数', valueType: 'number', unit: 'count', sortOrder: 60 },
  { key: 'allowedTemplateDatabaseTypes', kind: 'organization', labelEn: 'Template databases', labelZh: '模板数据库类型', valueType: 'stringList', unit: null, sortOrder: 10 },
  { key: 'includedSeats', kind: 'organization', labelEn: 'Included seats', labelZh: '包含席位', valueType: 'number', unit: 'seat', sortOrder: 20 },
  { key: 'maxSharedResources', kind: 'organization', labelEn: 'Shared resources', labelZh: '共享资源数', valueType: 'number', unit: 'count', sortOrder: 30 },
  { key: 'sharedStorageQuotaBytes', kind: 'organization', labelEn: 'Shared storage', labelZh: '共享存储空间', valueType: 'bytes', unit: 'bytes', sortOrder: 40 },
];

const ALL_ENGINES = ['mysql', 'postgresql', 'sqlite'] as const;

export const baselineMigration: Migration = {
  version: '001_baseline',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    // ─ 破坏性重置 ─────────────────────────────────────────────
    await db.query(`SET FOREIGN_KEY_CHECKS = 0`);
    for (const t of LEGACY_TABLES) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
    await db.query(`SET FOREIGN_KEY_CHECKS = 1`);
    await db.query(`DELETE FROM schema_migrations`);

    // ── 身份与会话 ─────────────────────────────────────────────
    await db.query(`
      CREATE TABLE users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        email_verified_time DATETIME(3) NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        role VARCHAR(16) NOT NULL DEFAULT 'user',
        session_version INT UNSIGNED NOT NULL DEFAULT 0,
        last_login_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_users_status (status),
        KEY idx_users_create (create_time),
        CONSTRAINT chk_users_status CHECK (status IN ('active', 'disabled')),
        CONSTRAINT chk_users_role CHECK (role IN ('user', 'platform_admin'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 套餐（统一）+ 特性纵表 ─────────────────────────────────
    await db.query(`
      CREATE TABLE plans (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(32) NOT NULL UNIQUE,
        kind VARCHAR(16) NOT NULL,
        name VARCHAR(64) NOT NULL,
        price_cents INT UNSIGNED NOT NULL DEFAULT 0,
        billing_unit VARCHAR(16) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        version INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_plans_kind_status (kind, status),
        CONSTRAINT chk_plans_kind CHECK (kind IN ('personal', 'organization')),
        CONSTRAINT chk_plans_billing_unit CHECK (billing_unit IN ('month', 'seat-month')),
        CONSTRAINT chk_plans_status CHECK (status IN ('active', 'archived'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE plan_feature_defs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        feature_key VARCHAR(64) NOT NULL UNIQUE,
        kind VARCHAR(16) NOT NULL,
        label_json JSON NOT NULL,
        value_type VARCHAR(16) NOT NULL,
        unit VARCHAR(16) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_feature_defs_kind (kind, sort_order),
        CONSTRAINT chk_feature_defs_kind CHECK (kind IN ('personal', 'organization', 'both')),
        CONSTRAINT chk_feature_defs_value_type CHECK (value_type IN ('bool', 'number', 'bytes', 'stringList', 'enum'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE plan_feature_values (
        plan_id BIGINT UNSIGNED NOT NULL,
        feature_def_id BIGINT UNSIGNED NOT NULL,
        value_json JSON NOT NULL,
        PRIMARY KEY (plan_id, feature_def_id),
        CONSTRAINT fk_pfv_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
        CONSTRAINT fk_pfv_def FOREIGN KEY (feature_def_id) REFERENCES plan_feature_defs(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 订阅（只引用 plan；无 entitlement_snapshot）────────────
    await db.query(`
      CREATE TABLE personal_subscriptions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL UNIQUE,
        plan_id BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        period_start_time DATETIME(3) NOT NULL,
        period_end_time DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_ps_plan (plan_id),
        CONSTRAINT chk_personal_sub_status CHECK (status IN ('active', 'expired', 'canceled')),
        CONSTRAINT fk_personal_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_personal_sub_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE email_verification_tokens (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        email VARCHAR(255) NOT NULL,
        purpose VARCHAR(16) NOT NULL DEFAULT 'initial',
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_time DATETIME(3) NOT NULL,
        consumed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_evt_user (user_id, consumed_time, expires_time),
        KEY idx_evt_expires (expires_time),
        KEY idx_evt_consumed (consumed_time),
        CONSTRAINT chk_evt_purpose CHECK (purpose IN ('initial', 'email_change'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE devices (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        device_key VARCHAR(128) NOT NULL,
        device_platform VARCHAR(100) NOT NULL DEFAULT '',
        device_name VARCHAR(100) NOT NULL DEFAULT '',
        client_version VARCHAR(100) NOT NULL DEFAULT '',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        last_used_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_device_user (user_id, device_key),
        CONSTRAINT chk_devices_status CHECK (status IN ('active', 'revoked')),
        CONSTRAINT fk_device_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE refresh_tokens (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        device_id BIGINT UNSIGNED NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        family_id CHAR(36) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        revoked_time DATETIME(3) NULL,
        last_used_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_rt_user (user_id, revoked_time, expires_time),
        KEY idx_rt_family (family_id, revoked_time),
        KEY idx_rt_device (device_id),
        KEY idx_rt_expires (expires_time),
        KEY idx_rt_revoked (revoked_time),
        CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE rate_limit_entries (
        bucket_key VARCHAR(255) NOT NULL,
        window_start_time DATETIME(3) NOT NULL,
        count INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (bucket_key, window_start_time),
        KEY idx_rate_window (window_start_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ─ 组织 ───────────────────────────────────────────────────
    await db.query(`
      CREATE TABLE organizations (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        closed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_org_name (name),
        KEY idx_org_status (status),
        CONSTRAINT chk_org_status CHECK (status IN ('active', 'closed')),
        CONSTRAINT chk_org_closed CHECK (
          (status = 'closed' AND closed_time IS NOT NULL) OR (status = 'active' AND closed_time IS NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE organization_subscriptions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL UNIQUE,
        plan_id BIGINT UNSIGNED NOT NULL,
        seat_limit SMALLINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        period_start_time DATETIME(3) NOT NULL,
        period_end_time DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 0,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_org_sub_plan (plan_id),
        CONSTRAINT chk_org_sub_status CHECK (status IN ('active', 'expired', 'canceled')),
        CONSTRAINT fk_org_sub_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
        CONSTRAINT fk_org_sub_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE organization_memberships (
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
        KEY idx_membership_user (user_id),
        CONSTRAINT chk_membership_role CHECK (role IN ('admin', 'member')),
        CONSTRAINT chk_membership_status CHECK (status IN ('invited', 'active', 'removed')),
        CONSTRAINT chk_membership_removed CHECK (
          (status = 'removed' AND removed_time IS NOT NULL) OR (status <> 'removed' AND removed_time IS NULL)
        ),
        CONSTRAINT fk_membership_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
        CONSTRAINT fk_membership_user FOREIGN KEY (user_id) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE organization_invitations (
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
        KEY idx_invitation_org (organization_id, expires_time),
        KEY idx_invitation_expires (expires_time),
        CONSTRAINT fk_invitation_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
        CONSTRAINT fk_invitation_membership FOREIGN KEY (membership_id) REFERENCES organization_memberships(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE organization_resource_folders (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        parent_id BIGINT UNSIGNED NULL,
        name VARCHAR(200) NOT NULL,
        delete_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_folder_org (organization_id),
        KEY idx_folder_parent (parent_id, organization_id),
        CONSTRAINT fk_folder_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE organization_resources (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL,
        folder_id BIGINT UNSIGNED NULL,
        resource_type VARCHAR(32) NOT NULL,
        name VARCHAR(200) NOT NULL,
        content JSON NOT NULL,
        version INT UNSIGNED NOT NULL,
        created_by_membership_id BIGINT UNSIGNED NOT NULL,
        updated_by_membership_id BIGINT UNSIGNED NULL,
        delete_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_resource_org (organization_id),
        KEY idx_resource_folder (folder_id),
        CONSTRAINT chk_resource_type CHECK (resource_type IN ('connection_template', 'query')),
        CONSTRAINT fk_resource_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
        CONSTRAINT fk_resource_folder FOREIGN KEY (folder_id) REFERENCES organization_resource_folders(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 个人端到端同步（无外键：高写入量表，理由见旧 009 注释）────
    await db.query(`
      CREATE TABLE personal_sync_state (
        user_id BIGINT UNSIGNED PRIMARY KEY,
        key_epoch BIGINT UNSIGNED NOT NULL,
        state_version BIGINT UNSIGNED NOT NULL,
        change_sequence BIGINT UNSIGNED NOT NULL,
        protocol_version TINYINT UNSIGNED NOT NULL,
        cipher_suite VARCHAR(32) NOT NULL,
        format_version INT UNSIGNED NOT NULL,
        smp_kdf_json JSON NOT NULL,
        recovery_kdf_json JSON NOT NULL,
        envelope_smp_version BIGINT UNSIGNED NOT NULL,
        envelope_smp_nonce BINARY(12) NOT NULL,
        envelope_smp_ct BINARY(32) NOT NULL,
        envelope_smp_tag BINARY(16) NOT NULL,
        envelope_recovery_version BIGINT UNSIGNED NOT NULL,
        envelope_recovery_nonce BINARY(12) NOT NULL,
        envelope_recovery_ct BINARY(32) NOT NULL,
        envelope_recovery_tag BINARY(16) NOT NULL,
        envelope_account_version BIGINT UNSIGNED NOT NULL,
        envelope_account_nonce BINARY(12) NOT NULL,
        envelope_account_ct BINARY(32) NOT NULL,
        envelope_account_tag BINARY(16) NOT NULL,
        account_recovery_key BINARY(32) NOT NULL,
        sign_pub BINARY(32) NOT NULL,
        recover_sign_pub BINARY(32) NOT NULL,
        recovery_code_set_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE personal_connection_meta (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        key_epoch BIGINT UNSIGNED NOT NULL,
        record_id VARBINARY(128) NOT NULL,
        cipher_suite VARCHAR(32) NOT NULL,
        format_version INT UNSIGNED NOT NULL,
        nonce BINARY(12) NOT NULL,
        ciphertext LONGBLOB NULL,
        tag BINARY(16) NULL,
        version BIGINT UNSIGNED NOT NULL,
        change_sequence BIGINT UNSIGNED NOT NULL,
        delete_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_conn_meta_user_epoch_record (user_id, key_epoch, record_id),
        KEY idx_conn_meta_user_epoch_seq (user_id, key_epoch, change_sequence)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE personal_sync_nonces (
        user_id BIGINT UNSIGNED NOT NULL,
        key_epoch BIGINT UNSIGNED NOT NULL,
        nonce BINARY(12) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, key_epoch, nonce)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE personal_sync_mutations (
        user_id BIGINT UNSIGNED NOT NULL,
        key_epoch BIGINT UNSIGNED NOT NULL,
        mutation_id BINARY(16) NOT NULL,
        request_digest BINARY(32) NOT NULL,
        action VARCHAR(32) NOT NULL,
        result_version BIGINT UNSIGNED NULL,
        result_change_sequence BIGINT UNSIGNED NULL,
        result_recovery_code_set_time DATETIME(3) NULL,
        status VARCHAR(16) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, key_epoch, mutation_id),
        KEY idx_sync_mutations_expires (expires_time),
        CONSTRAINT chk_sync_mutation_status CHECK (status IN ('applied'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE personal_sync_reset_tokens (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash BINARY(32) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        consumed_time DATETIME(3) NULL,
        revoked_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_sync_reset_token_hash (token_hash),
        KEY idx_sync_reset_token_user (user_id),
        KEY idx_sync_reset_token_expires (expires_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 邮件流 / 审计 / 幂等 / 交接 ────────────────────────────
    await db.query(`
      CREATE TABLE mail_flows (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(32) NOT NULL,
        target_token_hash BINARY(32) NOT NULL,
        target_record_id BIGINT UNSIGNED NULL,
        user_id BIGINT UNSIGNED NULL,
        nonce_hash BINARY(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'issued',
        expires_time DATETIME(3) NOT NULL,
        consumed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_mail_flows_nonce (nonce_hash),
        KEY idx_mail_flows_target (target_token_hash, status, expires_time),
        KEY idx_mail_flows_user (user_id, status, expires_time),
        KEY idx_mail_flows_expires (expires_time),
        KEY idx_mail_flows_consumed (consumed_time),
        CONSTRAINT chk_mail_flows_type CHECK (type IN ('verify-email', 'accept-invitation', 'sync-reset')),
        CONSTRAINT chk_mail_flows_status CHECK (status IN ('issued', 'consumed', 'expired', 'revoked'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE audit_events (
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
        KEY idx_audit_time (event_time),
        KEY idx_audit_actor (actor_user_id, event_time),
        KEY idx_audit_type (event_type, event_time),
        KEY idx_audit_org (organization_id, event_time),
        KEY idx_audit_target (target_type, target_id, event_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE idempotency_receipts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        actor_user_id BIGINT UNSIGNED NOT NULL,
        session_id VARCHAR(64) NOT NULL,
        method VARCHAR(8) NOT NULL,
        normalized_path VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(48) NOT NULL,
        request_digest BINARY(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'processing',
        http_status SMALLINT NULL,
        response_body LONGTEXT NULL,
        expires_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_idempotency (actor_user_id, session_id, method, normalized_path, idempotency_key),
        KEY idx_idempotency_expires (expires_time),
        CONSTRAINT chk_idempotency_status CHECK (status IN ('processing', 'completed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE sync_reset_handoffs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        reset_token_id BIGINT UNSIGNED NOT NULL,
        ticket_hash BINARY(32) NOT NULL,
        request_digest BINARY(32) NULL,
        result_state_dto_json MEDIUMTEXT NULL,
        result_key_epoch VARCHAR(64) NULL,
        result_state_version VARCHAR(64) NULL,
        result_change_sequence VARCHAR(64) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'issued',
        expires_time DATETIME(3) NOT NULL,
        consumed_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_sync_reset_handoff_ticket_hash (ticket_hash),
        KEY idx_sync_reset_handoff_reset_token (reset_token_id, status, expires_time),
        KEY idx_sync_reset_handoff_user (user_id, status, expires_time),
        KEY idx_sync_handoff_update (status, update_time),
        CONSTRAINT chk_sync_handoff_status CHECK (status IN ('issued', 'processing', 'completed', 'revoked', 'expired'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 支付 ───────────────────────────────────────────────────
    await db.query(`
      CREATE TABLE orders (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(64) NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        plan_code VARCHAR(32) NOT NULL,
        plan_version INT UNSIGNED NOT NULL DEFAULT 0,
        amount_cents BIGINT UNSIGNED NOT NULL,
        channel VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        channel_trade_no VARCHAR(64) NULL,
        paid_time DATETIME(3) NULL,
        expires_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_orders_order_no (order_no),
        KEY idx_orders_user (user_id, status, create_time),
        KEY idx_orders_trade (channel, channel_trade_no),
        KEY idx_orders_status_expires (status, expires_time),
        KEY idx_orders_plan (plan_code),
        KEY idx_orders_channel (channel),
        CONSTRAINT chk_orders_channel CHECK (channel IN ('wechat', 'alipay')),
        CONSTRAINT chk_orders_status CHECK (status IN ('pending', 'paid', 'fulfilled', 'failed', 'refunded', 'expired')),
        CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE payments (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id BIGINT UNSIGNED NOT NULL,
        channel VARCHAR(16) NOT NULL,
        channel_trade_no VARCHAR(64) NOT NULL,
        amount_cents BIGINT UNSIGNED NOT NULL,
        notify_summary MEDIUMTEXT NULL,
        result VARCHAR(16) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_payments_order (order_id, create_time),
        UNIQUE KEY uq_payments_channel_trade (channel, channel_trade_no),
        CONSTRAINT chk_payments_channel CHECK (channel IN ('wechat', 'alipay')),
        CONSTRAINT chk_payments_result CHECK (result IN ('success', 'failure', 'duplicate')),
        CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE invoices (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        order_id BIGINT UNSIGNED NULL,
        title VARCHAR(200) NOT NULL,
        tax_no VARCHAR(64) NULL,
        email VARCHAR(255) NOT NULL,
        amount_cents BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'requested',
        reason VARCHAR(500) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_invoices_order (order_id),
        KEY idx_invoices_user (user_id, create_time),
        KEY idx_invoices_status (status),
        CONSTRAINT chk_invoices_status CHECK (status IN ('requested', 'issued', 'rejected', 'failed')),
        CONSTRAINT fk_invoices_user FOREIGN KEY (user_id) REFERENCES users(id),
        CONSTRAINT fk_invoices_order FOREIGN KEY (order_id) REFERENCES orders(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE payment_callback_nonces (
        channel VARCHAR(16) NOT NULL,
        nonce_hash CHAR(64) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (channel, nonce_hash),
        KEY idx_pcn_expires (expires_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── 种子 ───────────────────────────────────────────────────
    const plans: ReadonlyArray<[string, string, string, number, string, number]> = [
      ['free', 'personal', 'Free', 0, 'month', 10],
      ['pro', 'personal', 'Pro', 9900, 'month', 20],
      ['organization_free', 'organization', 'Organization Free', 0, 'seat-month', 10],
      ['organization_team', 'organization', 'Organization Team', 0, 'seat-month', 20],
    ];
    for (const [code, kind, name, priceCents, billingUnit, sortOrder] of plans) {
      await db.query(
        `INSERT INTO plans (code, kind, name, price_cents, billing_unit, sort_order, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [code, kind, name, priceCents, billingUnit, sortOrder],
      );
    }

    for (const def of FEATURE_DEFS) {
      await db.query(
        `INSERT INTO plan_feature_defs (feature_key, kind, label_json, value_type, unit, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [def.key, def.kind, JSON.stringify({ en: def.labelEn, zh: def.labelZh }), def.valueType, def.unit, def.sortOrder],
      );
    }

    const values: ReadonlyArray<[string, string, unknown]> = [
      ['free', 'allowedDatabaseTypes', ['mysql', 'sqlite']],
      ['free', 'maxSavedConnections', 10],
      ['free', 'maxConnectionMetas', 500],
      ['free', 'syncStorageBytes', 33554432],
      ['free', 'allowConnectionImport', false],
      ['free', 'maxDevices', 0],
      ['pro', 'allowedDatabaseTypes', ALL_ENGINES],
      ['pro', 'maxSavedConnections', 100],
      ['pro', 'maxConnectionMetas', 5000],
      ['pro', 'syncStorageBytes', 268435456],
      ['pro', 'allowConnectionImport', true],
      ['pro', 'maxDevices', 0],
      ['organization_free', 'allowedTemplateDatabaseTypes', ['mysql']],
      ['organization_free', 'includedSeats', 3],
      ['organization_free', 'maxSharedResources', 50],
      ['organization_free', 'sharedStorageQuotaBytes', 10485760],
      ['organization_team', 'allowedTemplateDatabaseTypes', ALL_ENGINES],
      ['organization_team', 'includedSeats', 10],
      ['organization_team', 'maxSharedResources', 500],
      ['organization_team', 'sharedStorageQuotaBytes', 104857600],
    ];
    for (const [planCode, featureKey, value] of values) {
      await db.query(
        `INSERT INTO plan_feature_values (plan_id, feature_def_id, value_json)
         SELECT p.id, d.id, ? FROM plans p JOIN plan_feature_defs d
         WHERE p.code = ? AND d.feature_key = ?`,
        [JSON.stringify(value), planCode, featureKey],
      );
    }
  },
};