import { describe, it, expect } from 'vitest';
import { syncMutationRecoveryTimeMigration } from '../../src/repository/mysql/migrations/024_sync_mutation_recovery_time.js';

function makeDb(opts: { hasColumn: boolean }) {
  const queries: string[] = [];
  const db = {
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (sql.includes('SET time_zone')) return [[], undefined];
      if (sql.includes('information_schema.COLUMNS')) {
        return [opts.hasColumn ? [{ COLUMN_NAME: 'result_recovery_code_set_time' }] : [], undefined];
      }
      if (sql.includes('ALTER TABLE')) return [[], undefined];
      throw new Error('unexpected sql: ' + sql);
    },
  };
  return { db, queries };
}

describe('024_sync_mutation_recovery_time migration', () => {
  it('adds the column when missing', async () => {
    const { db, queries } = makeDb({ hasColumn: false });
    await syncMutationRecoveryTimeMigration.up(db);
    expect(queries.some((q) => q.includes('ADD COLUMN result_recovery_code_set_time'))).toBe(true);
  });

  it('skips when the column already exists', async () => {
    const { db, queries } = makeDb({ hasColumn: true });
    await syncMutationRecoveryTimeMigration.up(db);
    expect(queries.some((q) => q.includes('ADD COLUMN'))).toBe(false);
  });
});