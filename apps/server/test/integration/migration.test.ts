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
        'personal_subscriptions',
        'orders', 'payments', 'invoices', 'audit_events', 'personal_sync_state',
        'ai_token_usage', 'extension_installs', 'extension_active_days', 'feedback_replies',
      ]) {
        expect(names).toContain(t);
      }
      // 旧表已随 squash 消失；组织相关表亦已下线。
      expect(names).not.toContain('personal_plans');
      expect(names).not.toContain('organization_plans');
      expect(names).not.toContain('organizations');
      expect(names).not.toContain('organization_resources');

      // 订阅不再有快照列（权益派生）。
      const [cols] = (await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_subscriptions'
            AND COLUMN_NAME = 'entitlement_snapshot'`,
      )) as [Array<{ COLUMN_NAME: string }>, unknown];
      expect(cols).toHaveLength(0);

      // 种子：2 套餐 + 特性定义/取值（baseline 6/12 + 002 扩展 4/8 + 004 扩展 1/2 + 008 扩展 1/2 + 013 扩展 1/2）。
      const [planCount] = (await pool.query('SELECT COUNT(*) AS c FROM plans')) as [Array<{ c: number }>, unknown];
      expect(Number(planCount[0].c)).toBe(2);
      const [defCount] = (await pool.query('SELECT COUNT(*) AS c FROM plan_feature_defs')) as [Array<{ c: number }>, unknown];
      expect(Number(defCount[0].c)).toBe(13);
      const [valCount] = (await pool.query('SELECT COUNT(*) AS c FROM plan_feature_values')) as [Array<{ c: number }>, unknown];
      expect(Number(valCount[0].c)).toBe(26);

      // free 的引擎/配额经 EAV 派生正确（数量类型为 number）。
      const [freeFeatures] = (await pool.query(
        `SELECT d.feature_key, v.value_json
           FROM plans p
           JOIN plan_feature_values v ON v.plan_id = p.id
           JOIN plan_feature_defs d ON d.id = v.feature_def_id
          WHERE p.code = 'free'`,
      )) as [Array<{ feature_key: string; value_json: unknown }>, unknown];
      const byKey = new Map(freeFeatures.map((r) => [r.feature_key, typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json]));
      expect(byKey.get('allowedDatabaseTypes')).toEqual(['mysql', 'sqlite', 'redis']);
      expect(byKey.get('maxConnectionMetas')).toBe(500);
      expect(byKey.get('syncStorageBytes')).toBe(33554432);
    } finally {
      await pool.end();
    }
  });

  it('006_redis_engine：存量库幂等补 redis（重复执行不重复追加）', async () => {
    const pool = createTestPool();
    const readFree = async (): Promise<unknown> => {
      const [rows] = (await pool.query(
        `SELECT v.value_json
           FROM plans p
           JOIN plan_feature_values v ON v.plan_id = p.id
           JOIN plan_feature_defs d ON d.id = v.feature_def_id
          WHERE p.code = 'free' AND d.feature_key = 'allowedDatabaseTypes'`,
      )) as [Array<{ value_json: unknown }>, unknown];
      const raw = rows[0]?.value_json;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    };
    try {
      await dropAll(pool);
      // 模拟「已跑过 001（无 redis）」的存量库。
      const legacy = migrations.filter((m) => m.version !== '006_redis_engine');
      await runMigrations(pool as any, [...legacy], LEGACY_MIGRATION_VERSIONS);
      expect(await readFree()).toEqual(['mysql', 'sqlite']);

      // 增量 006 补上 redis。
      await runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS);
      expect(await readFree()).toEqual(['mysql', 'sqlite', 'redis']);

      // 再跑一次：幂等，不重复追加。
      await runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS);
      expect(await readFree()).toEqual(['mysql', 'sqlite', 'redis']);
    } finally {
      await pool.end();
    }
  });

  it('014_plan_engines_devices：Pro 增加 elasticsearch，设备数 free=2 / pro=5（幂等）', async () => {
    const pool = createTestPool();
    const readPlan = async (code: string): Promise<Map<string, unknown>> => {
      const [rows] = (await pool.query(
        `SELECT d.feature_key, v.value_json
           FROM plans p
           JOIN plan_feature_values v ON v.plan_id = p.id
           JOIN plan_feature_defs d ON d.id = v.feature_def_id
          WHERE p.code = ?`,
        [code],
      )) as [Array<{ feature_key: string; value_json: unknown }>, unknown];
      const byKey = new Map<string, unknown>();
      for (const r of rows) {
        byKey.set(r.feature_key, typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json);
      }
      return byKey;
    };
    try {
      await dropAll(pool);
      // 模拟存量库：只跑 001–013。
      //
      // 这里用版本切片而不是「排除 014」：排除法会把**后来新增的**迁移也带进这个
      // 「存量库」，019 就会提前把 Pro 的 maxDevices 改成 5，使下面的「014 之前为 0」
      // 断言失败（CI 实测）。切片让用例只依赖它要验证的那一段历史。
      const before014 = migrations.filter((m) => m.version < '014_plan_engines_devices');
      await runMigrations(pool as any, [...before014], LEGACY_MIGRATION_VERSIONS);
      const proBefore = await readPlan('pro');
      expect(proBefore.get('allowedDatabaseTypes')).toEqual(['mysql', 'postgresql', 'sqlite', 'redis']);
      expect(proBefore.get('maxDevices')).toBe(0);
      const freeBefore = await readPlan('free');
      expect(freeBefore.get('maxDevices')).toBe(0);

      // 只跑到 014：断言 014 自身的收敛效果，不让后续迁移参与。
      const through014 = migrations.filter((m) => m.version <= '014_plan_engines_devices');
      await runMigrations(pool as any, [...through014], LEGACY_MIGRATION_VERSIONS);
      const pro = await readPlan('pro');
      expect(pro.get('allowedDatabaseTypes')).toEqual(['mysql', 'postgresql', 'sqlite', 'redis', 'elasticsearch']);
      expect(pro.get('maxDevices')).toBe(5);
      expect((await readPlan('free')).get('maxDevices')).toBe(2);

      // 幂等
      await runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS);
      expect((await readPlan('pro')).get('allowedDatabaseTypes')).toEqual(['mysql', 'postgresql', 'sqlite', 'redis', 'elasticsearch']);
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
      expect(tableNames).toContain('user_feedback');
      expect(tableNames).toContain('extension_installs');

      const [ledger] = (await pool.query('SELECT version FROM schema_migrations')) as [Array<{ version: string }>, unknown];
      expect(ledger.map((r) => r.version)).toEqual(['001_baseline', '002_plan_features_v2', '003_plan_ordering', '004_authenticator_quota', '005_sync_entity_kind', '006_redis_engine', '007_audit_query_indexes', '008_ai_quota', '009_ai_topup', '010_ai_providers', '011_ai_model_pricing', '012_ai_credits_billing', '013_ai_credit_tiers', '014_plan_engines_devices', '015_user_feedback', '016_extension_telemetry', '017_feedback_replies', '018_extension_active_days', '019_plan_boundaries']);
    } finally {
      await pool.end();
    }
  });

  it('019_plan_boundaries：Free 关同步开导入、Pro 设备 5、标签改名（幂等，Free 设备/配额不动）', async () => {
    const pool = createTestPool();
    const readPlan = async (code: string): Promise<Map<string, unknown>> => {
      const [rows] = (await pool.query(
        `SELECT d.feature_key, v.value_json
           FROM plans p
           JOIN plan_feature_values v ON v.plan_id = p.id
           JOIN plan_feature_defs d ON d.id = v.feature_def_id
          WHERE p.code = ?`,
        [code],
      )) as [Array<{ feature_key: string; value_json: unknown }>, unknown];
      return new Map(rows.map((r) => [r.feature_key, typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json]));
    };
    const readLabel = async (): Promise<{ en: string; zh: string }> => {
      const [rows] = (await pool.query(
        `SELECT label_json FROM plan_feature_defs WHERE feature_key = 'maxConnectionMetas'`,
      )) as [Array<{ label_json: unknown }>, unknown];
      const raw = rows[0]?.label_json;
      return typeof raw === 'string' ? JSON.parse(raw) : (raw as { en: string; zh: string });
    };
    try {
      await dropAll(pool);
      // 模拟生产：已跑完 018，且 Pro 设备数仍是「不限」。
      const legacy = migrations.filter((m) => m.version !== '019_plan_boundaries');
      await runMigrations(pool as any, [...legacy], LEGACY_MIGRATION_VERSIONS);
      await pool.query(
        `UPDATE plan_feature_values v
           JOIN plans p ON p.id = v.plan_id
           JOIN plan_feature_defs d ON d.id = v.feature_def_id
            SET v.value_json = '0'
          WHERE p.code = 'pro' AND d.feature_key = 'maxDevices'`,
      );
      const freeBefore = await readPlan('free');
      expect(freeBefore.get('allowDataSync')).toBe(true);
      expect(freeBefore.get('allowConnectionImport')).toBe(false);
      expect((await readPlan('pro')).get('maxDevices')).toBe(0);
      expect((await readLabel()).zh).toBe('云端连接元数据');

      await runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS);
      const free = await readPlan('free');
      const pro = await readPlan('pro');
      expect(free.get('allowDataSync')).toBe(false);
      expect(free.get('allowConnectionImport')).toBe(true);
      expect(pro.get('allowDataSync')).toBe(true);
      expect(pro.get('allowConnectionImport')).toBe(true);
      expect(pro.get('maxDevices')).toBe(5);
      // 种子对齐：新库的默认值收敛到生产实际值
      expect(free.get('maxDevices')).toBe(1);
      expect(free.get('maxConnectionMetas')).toBe(5);
      expect(free.get('syncStorageBytes')).toBe(1048576);
      expect(free.get('allowedDatabaseTypes')).toEqual(['mysql', 'sqlite', 'redis', 'postgresql']);
      expect(free.get('maxConcurrentConnections')).toBe(2);
      expect(pro.get('maxConnectionMetas')).toBe(500);
      expect(pro.get('syncStorageBytes')).toBe(104857600);
      // 不在本迁移范围内的值保持原样
      for (const key of ['maxSavedConnections', 'maxAuthenticatorEntries']) {
        expect(free.get(key)).toBe(freeBefore.get(key));
      }
      expect(await readLabel()).toEqual({ en: 'Cloud sync records', zh: '云端同步记录数' });

      // 幂等
      await runMigrations(pool as any, [...migrations], LEGACY_MIGRATION_VERSIONS);
      expect((await readPlan('free')).get('allowDataSync')).toBe(false);
      expect((await readPlan('pro')).get('maxDevices')).toBe(5);
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
