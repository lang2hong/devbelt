import type { Migration } from '../migrate.js';

/**
 * 身份与会话 schema（6 张表，不含 schema_migrations，runner 自建）。
 *
 * 约束：
 * - 所有主键 BIGINT UNSIGNED AUTO_INCREMENT；时间 DATETIME(3) 以 UTC 读写。
 * - DB 列 snake_case；核心业务关系建外键。
 * - 建表顺序按外键依赖：users -> plan -> subscription -> email tokens -> devices -> refresh tokens。
 *
 * 迁移统一 `SET time_zone = '+00:00'`：应用只以 UTC 读写 DATETIME(3)，不依赖 DB
 * 或宿主机时区（实施规格 §2）。pool 侧时区由 mysqlPool.ts 的 `timezone: 'Z'` 兜住。
 */
export const usersAuthMigration: Migration = {
  version: '001_users_auth',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        email_verified_time DATETIME(3) NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        last_login_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_users_status CHECK (status IN ('active', 'disabled'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_plans (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(32) NOT NULL UNIQUE,
        name VARCHAR(64) NOT NULL,
        allowed_database_types JSON NOT NULL,
        max_devices SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_personal_plans_status CHECK (status IN ('active', 'archived'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS personal_subscriptions (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL UNIQUE,
        plan_id BIGINT UNSIGNED NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        entitlement_snapshot JSON NOT NULL,
        period_start_time DATETIME(3) NOT NULL,
        period_end_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_personal_sub_status CHECK (status IN ('active', 'expired', 'canceled')),
        CONSTRAINT fk_ps_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_ps_plan FOREIGN KEY (plan_id) REFERENCES personal_plans(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
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
        CONSTRAINT chk_evt_purpose CHECK (purpose IN ('initial', 'email_change')),
        CONSTRAINT fk_evt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS devices (
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
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        device_id BIGINT UNSIGNED NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        family_id CHAR(36) NOT NULL,
        replaced_by_token_id BIGINT UNSIGNED NULL,
        expires_time DATETIME(3) NOT NULL,
        revoked_time DATETIME(3) NULL,
        last_used_time DATETIME(3) NULL,
        create_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        update_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_rt_user (user_id, revoked_time, expires_time),
        KEY idx_rt_family (family_id, revoked_time),
        CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_rt_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
        CONSTRAINT fk_rt_replaced_by FOREIGN KEY (replaced_by_token_id) REFERENCES refresh_tokens(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
