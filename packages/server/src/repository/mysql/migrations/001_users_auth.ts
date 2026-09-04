import type { Migration } from '../migrate.js';

/**
 * 身份与会话 schema（6 张表，不含 schema_migrations，runner 自建）。
 *
 * 约束：
 * - 所有主键 BIGINT UNSIGNED AUTO_INCREMENT；时间 DATETIME(3) 以 UTC 读写。
 * - DB 列 snake_case。
 * - 建表顺序仍按依赖：users -> plan -> subscription -> email tokens -> devices -> refresh tokens。
 *
 * 外键取舍：全库只保留两根**鉴权链**外键 —— `devices.user_id → users` 与
 * `refresh_tokens.user_id → users`。它们有安全含义：防出现指向已删用户的孤儿
 * 设备/会话（孤儿 refresh token 是可利用的会话残留）。
 *
 * 其余外键一律去掉，因为本库的实际形态让它们只付成本不收红利：
 * - 生命周期全部走**软删**（status / delete_time），业务从不物理删父行，
 *   所以 `ON DELETE CASCADE` 永不触发，等于死代码；
 * - 引用完整性已由服务层在行锁内校验（见 organizationService / authService）；
 * - 而 FK 会持续收税：每次 INSERT 多一次父表查找与间隙锁，DDL 被子表约束挡住，
 *   且 FK 名在库内全局唯一 —— 迁移撞名会直接失败（曾因 `fk_member_org` 撞名
 *   导致 006 无法应用）。
 *
 * 删 FK 时必须补回它隐含的索引：MySQL 会为外键列自动建索引，删 FK 即删该索引。
 * 本文件因此显式补了 `idx_ps_plan`、`idx_rt_device`。
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
        -- 本机可保存的连接数上限；0 = 不限（数量差异点是「连接资产」，不是引擎）
        max_saved_connections INT UNSIGNED NOT NULL DEFAULT 0,
        -- 是否允许导入连接配置（导出恒允许）。free=0 / pro=1。
        allow_connection_import TINYINT(1) NOT NULL DEFAULT 0,
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
        KEY idx_ps_plan (plan_id),
        CONSTRAINT chk_personal_sub_status CHECK (status IN ('active', 'expired', 'canceled'))
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
        CONSTRAINT chk_evt_purpose CHECK (purpose IN ('initial', 'email_change'))
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
        -- device_id 原先由 fk_rt_device 自动带索引；删 FK 后需显式保留
        -- （revokeByDevice 按 device_id 撤销该设备全部会话）。
        KEY idx_rt_device (device_id),
        CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  },
};
