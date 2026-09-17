import { describe, expect, it } from 'vitest';
import { runMigrations, type MigrationDb } from '../../src/repository/mysql/migrate.js';
import { migrations, LEGACY_MIGRATION_VERSIONS } from '../../src/repository/mysql/migrations/index.js';

/**
 * fail-loud 常开单测（不依赖 MySQL）：账本含未知版本时拒绝启动，
 * 即使本机没有集成库也能守住这道防线。
 */
function fakeDb(appliedVersions: string[]): MigrationDb {
  return {
    query: async (sql: string) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return [[], undefined];
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return [appliedVersions.map((version) => ({ version })), undefined];
      }
      return [[], undefined];
    },
  };
}

describe('runMigrations fail-loud (unit)', () => {
  it('rejects an unknown ledger version', async () => {
    await expect(runMigrations(fakeDb(['999_future']), [...migrations], LEGACY_MIGRATION_VERSIONS)).rejects.toThrow(/未知版本/);
  });

  it('accepts a legacy ledger (baseline gets applied)', async () => {
    await expect(runMigrations(fakeDb(['001_users_auth', '024_sync_mutation_recovery_time']), [...migrations], LEGACY_MIGRATION_VERSIONS)).resolves.toBeUndefined();
  });

  it('skips when the baseline is already applied', async () => {
    await expect(runMigrations(fakeDb(['001_baseline']), [...migrations], LEGACY_MIGRATION_VERSIONS)).resolves.toBeUndefined();
  });
});