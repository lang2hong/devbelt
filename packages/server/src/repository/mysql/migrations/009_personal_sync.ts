import type { Migration } from '../migrate.js';

/**
 * 个人端到端同步数据层。
 *
 * forward-only：MySQL DDL 隐式提交，本迁移不假设可整体回滚；任一步失败即停部署、
 * 不启动依赖新 schema 的应用版本，由审查通过的前向 repair migration 修复。
 *
 * 顺序（§4.1）：①ALTER plans + seed → ②..⑥建表 → ⑦既有订阅快照回填。
 *
 * 不建外键（理由见 001 文件头）。这五张表原先都挂 `user_id → users ON DELETE CASCADE`，
 * 而 nonce ledger 与 connection_meta（LONGBLOB）是本库最大的两张表：一次删用户会
 * 触发跨这些大表的级联扫描。用户注销应走显式的分批清理服务，而不是让一条
 * `DELETE FROM users` 隐式牵动数百万行。
 * 每张表的 user_id 访问路径都已由主键或既有索引的前导列覆盖，无需额外补索引。
 * - personal_sync_state：严格单行（PK=user_id）；epoch/stateVersion/envelope 元数据 + 公开签名材料。
 * - personal_connection_meta：E2E record/tombstone；record nonce 唯一性由 personal_sync_nonces 单独强制（本表不加 unique）。
 * - personal_sync_nonces：永久 nonce ledger，防 AES-GCM nonce 复用（tombstone 亦计入）。
 * - personal_sync_mutations：mutation receipt（幂等重放）仅存定长 digest。
 * - personal_sync_reset_tokens：reset-after-loss 邮箱挑战，token_hash 只存 SHA-256。
 */
export const personalSyncMigration: Migration = {
  version: '009_personal_sync',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    // ① 个人套餐新增两项数值配额列（0=unlimited；Free 固定 500 / 33,554,432，§4.2）
    // 守卫：逐列查 information_schema，已存在则跳过——兼容旧账本重跑与 DDL 隐式提交的部分执行（ER_DUP_FIELDNAME）。
    const [columnRows] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_plans'
         AND COLUMN_NAME IN ('max_connection_metas', 'sync_storage_bytes')`,
    ) as [Array<{ COLUMN_NAME: string }>, unknown];
    const existingColumns = new Set(columnRows.map((r) => r.COLUMN_NAME));
    const addColumns: string[] = [];
    if (!existingColumns.has('max_connection_metas')) {
      addColumns.push('ADD COLUMN max_connection_metas BIGINT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!existingColumns.has('sync_storage_bytes')) {
      addColumns.push('ADD COLUMN sync_storage_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (addColumns.length > 0) {
      await db.query(`ALTER TABLE personal_plans ${addColumns.join(', ')}`);
    }
    await db.query(
      `UPDATE personal_plans SET max_connection_metas = 500, sync_storage_bytes = 33554432 WHERE code = 'free'`,
    );

    // ② 同步状态（每用户严格单行）
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_sync_state (
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
        sign_pub BINARY(32) NOT NULL,
        recover_sign_pub BINARY(32) NOT NULL,
        recovery_code_set_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ③ record / tombstone（ciphertext/tag 于 tombstone 时清空）
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_connection_meta (
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
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        delete_time DATETIME(3) NULL,
        UNIQUE KEY uq_conn_meta_user_epoch_record (user_id, key_epoch, record_id),
        KEY idx_conn_meta_user_epoch_seq (user_id, key_epoch, change_sequence)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ④ nonce ledger（非可选；防 AES-GCM nonce 复用）
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_sync_nonces (
        user_id BIGINT UNSIGNED NOT NULL,
        key_epoch BIGINT UNSIGNED NOT NULL,
        nonce BINARY(12) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, key_epoch, nonce)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ⑤ mutation receipt（幂等重放；仅定长字段）
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_sync_mutations (
        user_id BIGINT UNSIGNED NOT NULL,
        key_epoch BIGINT UNSIGNED NOT NULL,
        mutation_id BINARY(16) NOT NULL,
        request_digest BINARY(32) NOT NULL,
        action VARCHAR(32) NOT NULL,
        result_version BIGINT UNSIGNED NULL,
        result_change_sequence BIGINT UNSIGNED NULL,
        status VARCHAR(16) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, key_epoch, mutation_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ⑥ reset-after-loss 邮箱挑战 token
    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_sync_reset_tokens (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash BINARY(32) NOT NULL,
        expires_time DATETIME(3) NOT NULL,
        consumed_time DATETIME(3) NULL,
        revoked_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_sync_reset_token_hash (token_hash),
        KEY idx_sync_reset_token_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ⑦ 个人订阅快照回填两项权益（Free 固定值 §4.2）
    await db.query(
      `UPDATE personal_subscriptions
       SET entitlement_snapshot = JSON_SET(
         COALESCE(entitlement_snapshot, JSON_OBJECT()),
         '$.maxConnectionMetas', 500,
         '$.syncStorageBytes', 33554432
       )`,
    );
  },
};
