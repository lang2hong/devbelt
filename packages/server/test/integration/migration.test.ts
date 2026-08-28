import { describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { parseMysqlUrl, resolveTestDb } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';

const URL = process.env.MYSQL_TEST_URL;

describe.skipIf(!URL)('migration smoke (real MySQL)', () => {
  it('creates V3 tables and seeds the personal free plan', async () => {
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
      ]) {
        expect(names).toContain(t);
      }

      const [planRows] = (await pool.query(
        "SELECT code, max_devices, allowed_database_types FROM personal_plans WHERE code = 'free'",
      )) as [any[], unknown];
      expect(planRows).toHaveLength(1);
      expect(planRows[0].max_devices).toBe(0);
      expect(planRows[0].allowed_database_types).toEqual(['mysql', 'sqlite']);
    } finally {
      await pool.end();
    }
  });
});