import type { Migration } from '../migrate.js';

/**
 * 平台运营 schema（P3 切片 4）。
 *
 * 新增（哨兵式 guarded ALTER，兼容旧账本重跑）：
 * - `users.role`：平台角色，默认 'user'；仅 PLATFORM_ADMIN_EMAILS 受控引导写入。
 * - `personal_subscriptions.version` / `organization_subscriptions.version`：乐观并发版本
 *   （§6.2 订阅调整，expectedVersion → 402/409 SUBSCRIPTION_VERSION_CONFLICT）。
 * - 平台查询索引：`idx_audit_org`（审计按组织过滤）、`idx_audit_target`（按 target 过滤）。
 */
export const platformAdminMigration: Migration = {
  version: '015_platform_admin',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    const ensureColumn = async (table: string, column: string, ddl: string): Promise<void> => {
      const [rows] = (await db.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column],
      )) as [Array<{ COLUMN_NAME: string }>, unknown];
      if (rows.length === 0) await db.query(ddl);
    };

    await ensureColumn(
      'users',
      'role',
      `ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'`,
    );
    await addOrVerify(db,
      `ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN ('user', 'platform_admin'))`,
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
         AND CONSTRAINT_NAME = 'chk_users_role'`,
    );

    await ensureColumn(
      'personal_subscriptions',
      'version',
      `ALTER TABLE personal_subscriptions ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 0`,
    );
    await ensureColumn(
      'organization_subscriptions',
      'version',
      `ALTER TABLE organization_subscriptions ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 0`,
    );

    // 审计平台查询索引（audit_events 已由 012 建表；这里按需补列索引）。
    await addOrVerify(db,
      `CREATE INDEX idx_audit_org ON audit_events (organization_id, event_time)`,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events'
         AND INDEX_NAME = 'idx_audit_org'`,
    );
    await addOrVerify(db,
      `CREATE INDEX idx_audit_target ON audit_events (target_type, target_id, event_time)`,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events'
         AND INDEX_NAME = 'idx_audit_target'`,
    );
  },
};

/**
 * 执行 DDL；若因「对象已存在」失败，则回验目标约束/索引确实存在才吞下。
 *
 * 只忽略明确的「重复约束/键名」错误码；权限、语法、连接、锁超时等真实 DDL
 * 失败一律上抛，禁止 runner 写入版本账本（否则 schema 缺约束/索引却以为迁移完成）。
 */
async function addOrVerify(
  db: { query(sql: string, params?: any[]): Promise<any> },
  ddl: string,
  verifySql: string,
): Promise<void> {
  try {
    await db.query(ddl);
  } catch (e) {
    if (!isDuplicateObject(e)) throw e;
    const [rows] = (await db.query(verifySql)) as [Array<unknown>, unknown];
    if (!rows.length) throw e;
  }
}

function isDuplicateObject(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    ((err as { code?: string }).code === 'ER_DUP_KEYNAME' ||
      (err as { errno?: number }).errno === 1061 ||
      (err as { code?: string }).code === 'ER_DUP_CONSTRAINT' ||
      (err as { errno?: number }).errno === 3822)
  );
}