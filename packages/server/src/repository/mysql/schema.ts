import type { FastifyInstance } from 'fastify';

/**
 * 初始化数据库 schema（幂等）。
 * 建表 + plans 数据播种 + 旧表(users)补列。
 * 旧表 sync_data 暂保留兼容，期四切换 sync_sections 后废弃。
 *
 * 建库不在此处：`app.mysql` 是**连接池**，`USE db` 只对池中借出的那一条连接生效，
 * 其余连接仍无默认库，并发起来会 `ER_NO_DB_ERROR`。库的创建改由 `ensureDatabase()`
 * 在注册池之前用一条临时连接完成，池本身带 `database` 参数，见 app.ts。
 */
export async function initSchema(app: FastifyInstance): Promise<void> {
  const mysql = app.mysql;

  // plans 套餐定义表
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS plans (
      code VARCHAR(16) PRIMARY KEY,
      name VARCHAR(40) NOT NULL,
      price_month INT UNSIGNED NOT NULL DEFAULT 0,
      price_year INT UNSIGNED NOT NULL DEFAULT 0,
      max_devices SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      max_connections SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      sync_quota_bytes INT UNSIGNED NOT NULL DEFAULT 0,
      sync_version_retention SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      history_retention_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      max_pats SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      features INT UNSIGNED NOT NULL DEFAULT 0,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // 旧 plans 表补列（若已存在）
  await addColumnIfMissing(mysql, 'plans', 'sync_version_retention', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumnIfMissing(mysql, 'plans', 'max_connections', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');

  // users 表（新增字段幂等 ALTER；旧表若存在则补列）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'user',
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      plan_code VARCHAR(16) NOT NULL DEFAULT 'free',
      last_login_time TIMESTAMP NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // 旧 users 表补列
  await addColumnIfMissing(mysql, 'users', 'status', "VARCHAR(16) NOT NULL DEFAULT 'active'");
  await addColumnIfMissing(mysql, 'users', 'plan_code', "VARCHAR(16) NOT NULL DEFAULT 'free'");
  await addColumnIfMissing(mysql, 'users', 'last_login_time', "TIMESTAMP NULL DEFAULT NULL");
  await addColumnIfMissing(mysql, 'users', 'update_time', "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  // subscriptions 订阅表（一用户一行）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      plan_code VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      period_end_time TIMESTAMP NOT NULL,
      trial_end_time TIMESTAMP NULL DEFAULT NULL,
      cancel_time TIMESTAMP NULL DEFAULT NULL,
      provider VARCHAR(32) NOT NULL DEFAULT 'manual',
      external_id VARCHAR(255) NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_sub_user (user_id)
    ) ENGINE=InnoDB
  `);

  // refresh_tokens 设备会话表
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      device_name VARCHAR(120) NULL,
      user_agent VARCHAR(255) NULL,
      ip VARCHAR(45) NULL,
      expires_time TIMESTAMP NOT NULL,
      revoked_time TIMESTAMP NULL DEFAULT NULL,
      last_used_time TIMESTAMP NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_rt_user (user_id, revoked_time, expires_time)
    ) ENGINE=InnoDB
  `);

  // personal_access_tokens PAT 表
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS personal_access_tokens (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      name VARCHAR(80) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      scopes VARCHAR(255) NOT NULL DEFAULT '',
      last_used_time TIMESTAMP NULL DEFAULT NULL,
      expires_time TIMESTAMP NULL DEFAULT NULL,
      revoked_time TIMESTAMP NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_pat_user (user_id, revoked_time)
    ) ENGINE=InnoDB
  `);

  // sync_sections 分节同步当前版本表（方案 A）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS sync_sections (
      user_id INT UNSIGNED NOT NULL,
      section VARCHAR(16) NOT NULL,
      encrypted_data MEDIUMTEXT NOT NULL,
      version INT UNSIGNED NOT NULL DEFAULT 1,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, section),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  // sync_section_versions 历史版本表（回滚用）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS sync_section_versions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      section VARCHAR(16) NOT NULL,
      version INT UNSIGNED NOT NULL,
      encrypted_data MEDIUMTEXT NOT NULL,
      data_bytes INT UNSIGNED NOT NULL DEFAULT 0,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_sv_user_section (user_id, section, version)
    ) ENGINE=InnoDB
  `);

  // plans 数据播种
  await seedPlans(mysql);
}

/** 幂等加列：列不存在才 ADD（MySQL 无 IF NOT EXISTS 语法，靠错误码兼容） */
async function addColumnIfMissing(
  mysql: { query: (sql: string, p?: any[]) => Promise<any> },
  table: string,
  column: string,
  def: string,
): Promise<void> {
  try {
    await mysql.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
  } catch (err: any) {
    // ER_DUP_FIELDNAME(1060)：列已存在
    if (err?.code !== 'ER_DUP_FIELDNAME' && err?.errno !== 1060) throw err;
  }
}

interface PlanSeed {
  code: string;
  name: string;
  priceMonth: number;
  priceYear: number;
  maxDevices: number;
  maxConnections: number;
  syncQuotaBytes: number;
  syncVersionRetention: number;
  historyRetentionCount: number;
  maxPats: number;
  features: number;
}

const PLAN_SEED: PlanSeed[] = [
  {
    code: 'free', name: 'Free', priceMonth: 0, priceYear: 0,
    maxDevices: 1, maxConnections: 5, syncQuotaBytes: 1 * 1024 * 1024,
    syncVersionRetention: 3, historyRetentionCount: 50, maxPats: 0, features: 1,
  },
  {
    code: 'pro', name: 'Pro', priceMonth: 39, priceYear: 390,
    maxDevices: 5, maxConnections: 50, syncQuotaBytes: 100 * 1024 * 1024,
    syncVersionRetention: 30, historyRetentionCount: 0, maxPats: 3, features: 0b111,
  },
  {
    code: 'team', name: 'Team', priceMonth: 129, priceYear: 1290,
    maxDevices: 20, maxConnections: 500, syncQuotaBytes: 1024 * 1024 * 1024,
    syncVersionRetention: 90, historyRetentionCount: 0, maxPats: 20, features: 0b111111,
  },
];

async function seedPlans(mysql: { query: (sql: string, p?: any[]) => Promise<any> }): Promise<void> {
  for (const p of PLAN_SEED) {
    await mysql.query(
      `INSERT INTO plans (code, name, price_month, price_year, max_devices, max_connections, sync_quota_bytes, sync_version_retention, history_retention_count, max_pats, features)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), price_month = VALUES(price_month), price_year = VALUES(price_year),
         max_devices = VALUES(max_devices), max_connections = VALUES(max_connections),
         sync_quota_bytes = VALUES(sync_quota_bytes), sync_version_retention = VALUES(sync_version_retention),
         history_retention_count = VALUES(history_retention_count), max_pats = VALUES(max_pats),
         features = VALUES(features)`,
      [p.code, p.name, p.priceMonth, p.priceYear, p.maxDevices, p.maxConnections, p.syncQuotaBytes, p.syncVersionRetention, p.historyRetentionCount, p.maxPats, p.features],
    );
  }
}
