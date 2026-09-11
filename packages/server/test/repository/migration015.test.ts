import { describe, it, expect } from 'vitest';
import { platformAdminMigration } from '../../src/repository/mysql/migrations/015_platform_admin.js';

/**
 * 015 迁移 fail-closed 门禁：
 * - ADD CONSTRAINT / CREATE INDEX 只能吞「对象已存在」错误码（ER_DUP_CONSTRAINT 3822 /
 *   ER_DUP_KEYNAME 1061），且吞下后再经 information_schema 复核目标确实存在才继续；
 * - 复核结果为不存在 → 上抛；权限、语法、锁超时等其余错误一律上抛，禁止写账本。
 */

function makeDb(opts: {
  addConstraintError?: unknown;
  constraintVerifyRows: unknown[];
  createIndexError?: unknown;
  indexVerifyRows: unknown[];
}) {
  const queries: string[] = [];
  const db = {
    async query(sql: string, _params?: any[]): Promise<unknown> {
      queries.push(sql);
      if (sql.includes('SET time_zone')) return [[], undefined];
      if (sql.includes('information_schema.COLUMNS')) return [[], undefined];
      if (sql.includes('ADD COLUMN')) return [[], undefined];
      if (sql.includes('ADD CONSTRAINT chk_users_role')) {
        if (opts.addConstraintError) throw opts.addConstraintError;
        return [[], undefined];
      }
      if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
        return [opts.constraintVerifyRows, undefined];
      }
      if (sql.includes('CREATE INDEX')) {
        if (opts.createIndexError) throw opts.createIndexError;
        return [[], undefined];
      }
      if (sql.includes('information_schema.STATISTICS')) {
        return [opts.indexVerifyRows, undefined];
      }
      throw new Error('unexpected sql: ' + sql);
    },
  };
  return { db, queries };
}

describe('015_platform_admin fail-closed', () => {
  it('creates constraint and indexes when absent and no error occurs', async () => {
    const { db, queries } = makeDb({ constraintVerifyRows: [], indexVerifyRows: [] });
    await expect(platformAdminMigration.up(db)).resolves.toBeUndefined();
    expect(queries.some((q) => q.includes('ADD CONSTRAINT chk_users_role'))).toBe(true);
    expect(queries.some((q) => q.includes('CREATE INDEX idx_audit_org'))).toBe(true);
    expect(queries.some((q) => q.includes('CREATE INDEX idx_audit_target'))).toBe(true);
  });

  it('swallows ER_DUP_CONSTRAINT when re-verified constraint exists', async () => {
    const dup = Object.assign(new Error('dup constraint'), { errno: 3822 });
    const { db } = makeDb({ addConstraintError: dup, constraintVerifyRows: [{ CONSTRAINT_NAME: 'chk_users_role' }], indexVerifyRows: [] });
    await expect(platformAdminMigration.up(db)).resolves.toBeUndefined();
  });

  it('throws when ER_DUP_CONSTRAINT but re-verify finds no constraint', async () => {
    const dup = Object.assign(new Error('dup constraint'), { errno: 3822 });
    const { db } = makeDb({ addConstraintError: dup, constraintVerifyRows: [], indexVerifyRows: [] });
    await expect(platformAdminMigration.up(db)).rejects.toBe(dup);
  });

  it('throws on permission/syntax errors (not swallowed)', async () => {
    const denied = Object.assign(new Error('access denied'), { errno: 1044 });
    const { db } = makeDb({ addConstraintError: denied, constraintVerifyRows: [], indexVerifyRows: [] });
    await expect(platformAdminMigration.up(db)).rejects.toBe(denied);
  });

  it('throws when create index hits ER_DUP_KEYNAME but re-verify finds no index', async () => {
    const dupKey = Object.assign(new Error('dup key name'), { errno: 1061 });
    const { db } = makeDb({ constraintVerifyRows: [], createIndexError: dupKey, indexVerifyRows: [] });
    await expect(platformAdminMigration.up(db)).rejects.toBe(dupKey);
  });

  it('swallows ER_DUP_KEYNAME for index when re-verified index exists', async () => {
    const dupKey = Object.assign(new Error('dup key name'), { errno: 1061 });
    const { db } = makeDb({ constraintVerifyRows: [], createIndexError: dupKey, indexVerifyRows: [{ INDEX_NAME: 'idx_audit_org' }] });
    await expect(platformAdminMigration.up(db)).resolves.toBeUndefined();
  });
});