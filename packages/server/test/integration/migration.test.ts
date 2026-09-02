import { describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { parseMysqlUrl, resolveTestDb } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';

const URL = process.env.MYSQL_TEST_URL;

function unjson<T>(v: T): T {
  return typeof v === 'string' ? (JSON.parse(v) as T) : v;
}

describe.skipIf(!URL)('migration smoke (real MySQL)', () => {
  it('creates tables and seeds the personal free plan', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const pool = mysql.createPool({ host, port, user, password, database: resolveTestDb(), timezone: 'Z' });
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
    } finally {
      await pool.end();
    }
  });

  it('backfills existing subscription snapshots when applying 009', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const pool = mysql.createPool({ host, port, user, password, database: resolveTestDb(), timezone: 'Z' });
    try {
      // 隔离：重建「迁移 001–008 已应用、009 未应用」的世界
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      const [t0] = await pool.query('SHOW TABLES');
      for (const r of t0 as Array<Record<string, unknown>>) {
        await pool.query(`DROP TABLE IF EXISTS \`${String(Object.values(r)[0])}\``);
      }
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');

      await runMigrations(pool as any, migrations.slice(0, 8));

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

      await runMigrations(pool as any, migrations.slice(8));

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
});
