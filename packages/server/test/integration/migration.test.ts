import { describe, it, expect } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';

const URL = process.env.MYSQL_TEST_URL;

function unjson<T>(v: T): T {
  return typeof v === 'string' ? (JSON.parse(v) as T) : v;
}

describe.skipIf(!URL)('migration smoke (real MySQL)', () => {
  it('creates tables and seeds the personal free plan', async () => {
    const pool = createTestPool();
    try {
      await runMigrations(pool as any, [...migrations]);

      const [tableRows] = await pool.query('SHOW TABLES');
      const names = (tableRows as any[]).map((r) => Object.values(r)[0] as string);
      for (const t of [
        'users',
        'personal_plans',
        'personal_subscriptions',
        'email_verification_tokens',
        'devices',
        'refresh_tokens',
        'rate_limit_entries',
        'personal_sync_state',
        'personal_connection_meta',
        'personal_sync_nonces',
        'personal_sync_mutations',
        'personal_sync_reset_tokens',
        'mail_flows',
        'audit_events',
        'orders',
        'payments',
        'invoices',
      ]) {
        expect(names).toContain(t);
      }

      const [planRows] = (await pool.query(
        'SELECT code, max_devices, allowed_database_types, max_connection_metas, sync_storage_bytes FROM personal_plans WHERE code = \'free\'',
      )) as [any[], unknown];
      expect(planRows).toHaveLength(1);
      expect(planRows[0].max_devices).toBe(0);
      expect(unjson(planRows[0].allowed_database_types)).toEqual(['mysql', 'sqlite']);
      expect(planRows[0].max_connection_metas).toBe(500);
      expect(planRows[0].sync_storage_bytes).toBe(33554432);

      // mail_flows 清理为索引化分批删除：到期/消费两索引必须存在。
      const [indexRows] = await pool.query('SHOW INDEX FROM mail_flows') as [Array<{ Key_name: string }>, unknown];
      const indexNames = new Set(indexRows.map((r) => r.Key_name));
      expect(indexNames).toContain('idx_mail_flows_expires');
      expect(indexNames).toContain('idx_mail_flows_consumed');

      // 019：invoices 的订单级唯一索引（一订单一票，税务不变量）：名 + 唯一 + 且仅 order_id 单列。
      const [invIndexRows] = await pool.query('SHOW INDEX FROM invoices') as [Array<{ Key_name: string; Non_unique: number; Column_name: string }>, unknown];
      const uniq = invIndexRows.filter((r) => r.Key_name === 'uq_invoices_order');
      expect(uniq).toHaveLength(1);
      expect(uniq[0].Non_unique).toBe(0);
      expect(uniq[0].Column_name).toBe('order_id');

      // 013_console_session：users.session_version 已存在（会话即时失效依赖）。
      const [svCols] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'session_version'`,
      ) as [Array<{ COLUMN_NAME: string }>, unknown];
      expect(svCols).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it('backfills existing subscription snapshots when applying 009', async () => {
    const pool = createTestPool();
    try {
      // 隔离：重建「迁移 001–008 已应用、009 未应用」的世界
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      const [t0] = await pool.query('SHOW TABLES');
      for (const r of t0 as Array<Record<string, unknown>>) {
        await pool.query(`DROP TABLE IF EXISTS \`${String(Object.values(r)[0])}\``);
      }
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');

      // 按版本号定位 009 的位置，而不是写死索引 8：
      // 本用例验证的是「009 对既有订阅快照的回填」，前置条件是「009 之前全部已应用」。
      const syncIdx = migrations.findIndex((m) => m.version === '009_personal_sync');
      expect(syncIdx).toBeGreaterThan(0);
      await runMigrations(pool as any, migrations.slice(0, syncIdx));

      const [planRows] = (await pool.query(
        "SELECT id FROM personal_plans WHERE code = 'free' LIMIT 1",
      )) as [any[], unknown];
      const [userRes] = (await pool.query(
        "INSERT INTO users (email, password_hash, display_name, status) VALUES ('backfill@test.local', 'hash', NULL, 'active')",
      )) as [any, unknown];
      const userId = Number(userRes.insertId);
      await pool.query(
        `INSERT INTO personal_subscriptions (user_id, plan_id, status, entitlement_snapshot, period_start_time, period_end_time)
         VALUES (?, ?, 'active', ?, NOW(3), NULL)`,
        [userId, planRows[0].id, JSON.stringify({ allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 0 })],
      );

      await runMigrations(pool as any, migrations.slice(syncIdx));

      const [sub] = (await pool.query(
        'SELECT entitlement_snapshot FROM personal_subscriptions WHERE user_id = ?',
        [userId],
      )) as [any[], unknown];
      const snapshot = unjson(sub[0].entitlement_snapshot);
      expect(snapshot.maxConnectionMetas).toBe(500);
      expect(snapshot.syncStorageBytes).toBe(33554432);
      // 既有键保持原样
      expect(snapshot.allowedDatabaseTypes).toEqual(['mysql', 'sqlite']);
      expect(snapshot.maxDevices).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('normalizes legacy *_v3 ledger keys and skips re-run (no duplicate columns)', async () => {
    const pool = createTestPool();
    try {
      // 隔离：重建空库
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      const [t0] = await pool.query('SHOW TABLES');
      for (const r of t0 as Array<Record<string, unknown>>) {
        await pool.query(`DROP TABLE IF EXISTS \`${String(Object.values(r)[0])}\``);
      }
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');

      // 首次正常迁移建表并播种
      await runMigrations(pool as any, [...migrations]);

      // 模拟旧库：账本键改回 *_v3（分节同步时代）。personal_plans 两列已因首次迁移存在。
      await pool.query("UPDATE schema_migrations SET version = CONCAT(version, '_v3')");

      // 重跑：归一化后应全部跳过，不得因 ADD COLUMN 重入而 ER_DUP_FIELDNAME
      await runMigrations(pool as any, [...migrations]);

      // 两列各只出现一次
      const [cols] = await pool.query(
        `SELECT COLUMN_NAME, COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_plans'
           AND COLUMN_NAME IN ('max_connection_metas', 'sync_storage_bytes')
         GROUP BY COLUMN_NAME`,
      ) as [Array<Record<string, unknown>>, unknown];
      expect(cols).toHaveLength(2);
      for (const row of cols) expect(Number(row.c)).toBe(1);

      // seed 未重复：free plan 仍仅一行
      const [planRows] = (await pool.query("SELECT COUNT(*) AS c FROM personal_plans WHERE code = 'free'")) as [Array<{ c: number }>, unknown];
      expect(Number(planRows[0].c)).toBe(1);

      // 账本保留 *_v3 键（归一化只读，不改写历史）
      // 长度从 migrations 推导：硬编码会让「新增一个迁移」连带改测试。
      const [ledger] = (await pool.query('SELECT version FROM schema_migrations')) as [Array<{ version: string }>, unknown];
      expect(ledger).toHaveLength(migrations.length);
      expect(ledger.every((r) => r.version.endsWith('_v3'))).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('re-adds only the missing column when 009 partially applied', async () => {
    const pool = createTestPool();
    try {
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      const [t0] = await pool.query('SHOW TABLES');
      for (const r of t0 as Array<Record<string, unknown>>) {
        await pool.query(`DROP TABLE IF EXISTS \`${String(Object.values(r)[0])}\``);
      }
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');

      await runMigrations(pool as any, [...migrations]);

      // 部分执行模拟：删掉其中一列，同时移除 009 账本行（含 legacy 别名）让 009 重跑。
      await pool.query('ALTER TABLE personal_plans DROP COLUMN sync_storage_bytes');
      await pool.query("DELETE FROM schema_migrations WHERE version IN ('009_personal_sync', '009_personal_sync_v3')");

      await runMigrations(pool as any, [...migrations]);

      // 只补回被删的一列，另一列未被重复添加，且无异常。
      const [cols] = await pool.query(
        `SELECT COLUMN_NAME, COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_plans'
           AND COLUMN_NAME IN ('max_connection_metas', 'sync_storage_bytes')
         GROUP BY COLUMN_NAME`,
      ) as [Array<Record<string, unknown>>, unknown];
      expect(cols).toHaveLength(2);
      for (const row of cols) expect(Number(row.c)).toBe(1);

      // 账本回到 migrations.length 行且名称为无后缀
      const [ledger] = (await pool.query('SELECT version FROM schema_migrations')) as [Array<{ version: string }>, unknown];
      expect(ledger).toHaveLength(migrations.length);
      expect(ledger.every((r) => !r.version.endsWith('_v3'))).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
