import { describe, it, expect } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations, LEGACY_MIGRATION_VERSIONS } from '../../src/repository/mysql/migrations/index.js';

const URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;

async function dropAll(pool: any): Promise<void> {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  const [rows] = (await pool.query('SHOW TABLES')) as [Array<Record<string, unknown>>, unknown];
  for (const r of rows) await pool.query(`DROP TABLE IF EXISTS \`${String(Object.values(r)[0])}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}

describe.skipIf(!URL)('baseline migration (real MySQL)', () => {
  it('creates the clean schema and seeds plans + feature defs/values', async () => {
    const pool = createTestPool();
    try {
      await dropAll(pool);
      await runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS);

      const [tableRows] = await pool.query('SHOW TABLES');
      const names = (tableRows as any[]).map((r) => Object.values(r)[0] as string);
      for (const t of [
        'users', 'plans', 'plan_feature_defs', 'plan_feature_values',
        'personal_subscriptions', 'organization_subscriptions', 'organizations',
        'orders', 'payments', 'invoices', 'audit_events', 'personal_sync_state',
      ]) {
        expect(names).toContain(t);
      }
      // 旧表已随 squash 消失
      expect(names).not.toContain('personal_plans');
      expect(names).not.toContain('organization_plans');

      // 订阅不再有快照列（权益派生）。
      const [cols] = (await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_subscriptions'
            AND COLUMN_NAME = 'entitlement_snapshot'`,
      )) as [Array<{ COLUMN_NAME: string }>, unknown];
      expect(cols).toHaveLength(0);

      // 种子：4 套餐 + 特性定义/取值（baseline 10/20 + 002 扩展 4/8）。
      const [planCount] = (await pool.query('SELECT COUNT(*) AS c FROM plans')) as [Array<{ c: number }>, unknown];
      expect(Number(planCount[0].c)).toBe(4);
      const [defCount] = (await pool.query('SELECT COUNT(*) AS c FROM plan_feature_defs')) as [Array<{ c: number }>, unknown];
      expect(Number(defCount[0].c)).toBe(14);
      const [valCount] = (await pool.query('SELECT COUNT(*) AS c FROM plan_feature_values')) as [Array<{ c: number }>, unknown];
      expect(Number(valCount[0].c)).toBe(28);

      // free 的引擎/配额经 EAV 派生正确（数量类型为 number）。
      const [freeFeatures] = (await pool.query(
        `SELECT d.feature_key, v.value_json
           FROM plans p
           JOIN plan_feature_values v ON v.plan_id = p.id
           JOIN plan_feature_defs d ON d.id = v.feature_def_id
          WHERE p.code = 'free'`,
      )) as [Array<{ feature_key: string; value_json: unknown }>, unknown];
      const byKey = new Map(freeFeatures.map((r) => [r.feature_key, typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json]));
      expect(byKey.get('allowedDatabaseTypes')).toEqual(['mysql', 'sqlite']);
      expect(byKey.get('maxConnectionMetas')).toBe(500);
      expect(byKey.get('syncStorageBytes')).toBe(33554432);
    } finally {
      await pool.end();
    }
  });

  it('accepts a legacy ledger (001–024) and rebuilds via baseline', async () => {
    const pool = createTestPool();
    try {
      await dropAll(pool);
      await pool.query(
        `CREATE TABLE schema_migrations (version VARCHAR(64) NOT NULL PRIMARY KEY, applied_time DATETIME NOT NULL) ENGINE=InnoDB`,
      );
      for (const v of LEGACY_MIGRATION_VERSIONS) {
        await pool.query('INSERT INTO schema_migrations (version, applied_time) VALUES (?, NOW())', [v]);
      }

      await runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS);

      const [names] = (await pool.query('SHOW TABLES')) as [Array<Record<string, unknown>>, unknown];
      const tableNames = names.map((r) => Object.values(r)[0] as string);
      expect(tableNames).toContain('plans');

      const [ledger] = (await pool.query('SELECT version FROM schema_migrations')) as [Array<{ version: string }>, unknown];
      expect(ledger.map((r) => r.version)).toEqual(['001_baseline', '002_plan_features_v2', '003_plan_ordering']);
    } finally {
      await pool.end();
    }
  });

  it('fails loud on an unknown ledger version (no silent rebuild)', async () => {
    const pool = createTestPool();
    try {
      await dropAll(pool);
      await pool.query(
        `CREATE TABLE schema_migrations (version VARCHAR(64) NOT NULL PRIMARY KEY, applied_time DATETIME NOT NULL) ENGINE=InnoDB`,
      );
      await pool.query('INSERT INTO schema_migrations (version, applied_time) VALUES (?, NOW())', ['999_future']);

      await expect(runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS)).rejects.toThrow(/未知版本/);
    } finally {
      // 必须清理：该用例把 999_future 写进共享测试库的 schema_migrations，
      // 若残留会令后续用例的 runMigrations 拒绝启动（unknown version），级联失败。
      await dropAll(pool);
      await pool.end();
    }
  });
});