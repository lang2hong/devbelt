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
    await db.query(
      `ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN ('user', 'platform_admin'))`,
    ).catch(() => {
      // 已存在同名列时 CONNECTION 报错；忽略（guard 与幂等重跑）
    });

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
    await db.query(
      `CREATE INDEX idx_audit_org ON audit_events (organization_id, event_time)`,
    ).catch(() => {});
    await db.query(
      `CREATE INDEX idx_audit_target ON audit_events (target_type, target_id, event_time)`,
    ).catch(() => {});
  },
};