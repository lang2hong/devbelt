import type { Migration } from '../migrate.js';

/**
 * 组织功能下线：清理组织相关表 / 种子 / 列与约束（幂等）。
 *
 * 基线（001）已不再创建这些对象；本迁移仅用于**曾应用旧基线**的库收敛。全部步骤
 * 以「存在才做」为条件，重复执行无副作用。
 *
 * 顺序：
 * 1. 清种子：组织套餐（级联 plan_feature_values）与组织特性定义。
 * 2. 删组织表（子表 → 父表）。
 * 3. audit_events 去 organization_id 列与 idx_audit_org 索引。
 * 4. mail_flows 的 type CHECK 收紧为 verify-email / sync-reset。
 * 5. plans.kind 与 plan_feature_defs.kind CHECK 收紧（若仍允许 organization）。
 */
export const dropOrganizationMigration: Migration = {
  version: '006_drop_organization',
  async up(db): Promise<void> {
    await db.query(`SET time_zone = '+00:00'`);

    // 1. 清种子。
    await db.query(`DELETE FROM plans WHERE kind = 'organization'`);
    await db.query(`DELETE FROM plan_feature_defs WHERE kind = 'organization'`);

    // 2. 删组织表（子表 → 父表）。
    const orgTables = [
      'organization_resources',
      'organization_resource_folders',
      'organization_invitations',
      'organization_memberships',
      'organization_subscriptions',
      'organizations',
      'organization_plans',
    ];
    for (const table of orgTables) {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
    }

    // 3. audit_events 去组织列/索引（MySQL 无 DROP COLUMN/INDEX IF EXISTS）。
    if (await hasIndex(db, 'audit_events', 'idx_audit_org')) {
      await db.query(`ALTER TABLE audit_events DROP INDEX idx_audit_org`);
    }
    if (await hasColumn(db, 'audit_events', 'organization_id')) {
      await db.query(`ALTER TABLE audit_events DROP COLUMN organization_id`);
    }

    // 4. mail_flows 收紧 type CHECK。
    await retightenCheck(
      db,
      'mail_flows',
      'chk_mail_flows_type',
      `type IN ('verify-email', 'sync-reset')`,
      'organization',
    );

    // 5. plans / plan_feature_defs 收紧 kind CHECK。
    await retightenCheck(db, 'plans', 'chk_plans_kind', `kind IN ('personal')`, 'organization');
    await retightenCheck(
      db,
      'plan_feature_defs',
      'chk_feature_defs_kind',
      `kind IN ('personal', 'both')`,
      'organization',
    );
  },
};

type GuardDb = { query(sql: string, params?: any[]): Promise<any> };

async function hasColumn(db: GuardDb, table: string, column: string): Promise<boolean> {
  const [rows] = (await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )) as [unknown[], unknown];
  return rows.length > 0;
}

async function hasIndex(db: GuardDb, table: string, index: string): Promise<boolean> {
  const [rows] = (await db.query(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  )) as [unknown[], unknown];
  return rows.length > 0;
}

/**
 * 若目标 CHECK 存在且其定义仍包含 `staleToken`，则 DROP 后以 `clause` 重建。
 * 免于重复收紧，也避免 MySQL 不支持 `DROP CHECK IF EXISTS` 的问题。
 */
async function retightenCheck(
  db: GuardDb,
  table: string,
  constraint: string,
  clause: string,
  staleToken: string,
): Promise<void> {
  const [rows] = (await db.query(
    `SELECT cc.check_clause AS clause
       FROM information_schema.check_constraints cc
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = cc.constraint_name
        AND tc.constraint_schema = cc.constraint_schema
      WHERE cc.constraint_schema = DATABASE() AND tc.table_name = ? AND cc.constraint_name = ?
      LIMIT 1`,
    [table, constraint],
  )) as [Array<{ clause?: string }>, unknown];
  const current = rows[0]?.clause;
  if (current === undefined) return;
  if (!current.includes(staleToken)) return;
  await db.query(`ALTER TABLE ${table} DROP CHECK ${constraint}`);
  await db.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${clause})`);
}