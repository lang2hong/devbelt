import { describe, it, expect } from 'vitest';
import { invoiceStatusReasonMigration } from '../../src/repository/mysql/migrations/023_invoice_status_reason.js';

/**
 * 023 幂等守卫：新增 reason 列 + 扩展 CHECK 约束含 failed。
 * - reason 列已存在则不再 ADD COLUMN；
 * - CHECK 约束不存在 → 直接 ADD（覆盖上次 DROP 成功、ADD 失败的残态）；
 * - CHECK_CLAUSE 已含 'failed' 则不再 DROP/ADD 约束。
 */

function makeDb(opts: { reasonCols: string[]; clause: string | null }) {
  const queries: string[] = [];
  const db = {
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (sql.includes('SET time_zone')) return [[], undefined];
      if (sql.includes('information_schema.COLUMNS')) {
        return [opts.reasonCols.map((c) => ({ COLUMN_NAME: c })), undefined];
      }
      if (sql.includes('information_schema.CHECK_CONSTRAINTS')) {
        return [opts.clause === null ? [] : [{ CHECK_CLAUSE: opts.clause }], undefined];
      }
      if (sql.includes('ALTER TABLE')) return [[], undefined];
      throw new Error('unexpected sql: ' + sql);
    },
  };
  return { db, queries };
}

describe('023_invoice_status_reason migration', () => {
  it('adds reason column and rewrites CHECK when neither exists', async () => {
    const { db, queries } = makeDb({ reasonCols: [], clause: "`status` in (_utf8mb4'requested',_utf8mb4'issued',_utf8mb4'rejected')" });
    await invoiceStatusReasonMigration.up(db);
    expect(queries.some((q) => q.includes('ADD COLUMN reason'))).toBe(true);
    expect(queries.some((q) => q.includes('DROP CHECK chk_invoices_status'))).toBe(true);
    expect(queries.some((q) => q.includes("ADD CONSTRAINT chk_invoices_status"))).toBe(true);
  });

  it('skips everything when reason column and failed-enum both exist', async () => {
    const { db, queries } = makeDb({ reasonCols: ['reason'], clause: "`status` in (_utf8mb4'requested',_utf8mb4'issued',_utf8mb4'rejected',_utf8mb4'failed')" });
    await invoiceStatusReasonMigration.up(db);
    expect(queries.some((q) => q.includes('ADD COLUMN'))).toBe(false);
    expect(queries.some((q) => q.includes('DROP CHECK'))).toBe(false);
  });

  it('rewrites only the CHECK when reason column already exists', async () => {
    const { db, queries } = makeDb({ reasonCols: ['reason'], clause: "`status` in (_utf8mb4'requested',_utf8mb4'issued',_utf8mb4'rejected')" });
    await invoiceStatusReasonMigration.up(db);
    expect(queries.some((q) => q.includes('ADD COLUMN reason'))).toBe(false);
    expect(queries.some((q) => q.includes('DROP CHECK chk_invoices_status'))).toBe(true);
    expect(queries.some((q) => q.includes("ADD CONSTRAINT chk_invoices_status"))).toBe(true);
  });

  it('adds the CHECK without DROP when the constraint is missing (partial-execution residue)', async () => {
    const { db, queries } = makeDb({ reasonCols: ['reason'], clause: null });
    await invoiceStatusReasonMigration.up(db);
    expect(queries.some((q) => q.includes('ADD COLUMN'))).toBe(false);
    expect(queries.some((q) => q.includes('DROP CHECK'))).toBe(false);
    expect(queries.some((q) => q.includes("ADD CONSTRAINT chk_invoices_status"))).toBe(true);
  });
});

describe('023_invoice_status_reason migration (concurrent DDL race)', () => {
  /** 可变状态 fake：首次 ADD COLUMN 抛重复列错误，同时状态已被「另一实例」推进到最终态。 */
  function makeRacingDb(opts: { convergeToFinal: boolean }) {
    let reasonCols: string[] = [];
    let clause: string | null = null;
    let addColumnAttempts = 0;
    const failedClause = "`status` in (_utf8mb4'requested',_utf8mb4'issued',_utf8mb4'rejected',_utf8mb4'failed')";
    const db = {
      async query(sql: string): Promise<unknown> {
        if (sql.includes('SET time_zone')) return [[], undefined];
        if (sql.includes('information_schema.COLUMNS')) {
          return [reasonCols.map((c) => ({ COLUMN_NAME: c })), undefined];
        }
        if (sql.includes('information_schema.CHECK_CONSTRAINTS')) {
          return [clause === null ? [] : [{ CHECK_CLAUSE: clause }], undefined];
        }
        if (sql.includes('ALTER TABLE')) {
          if (sql.includes('ADD COLUMN')) {
            addColumnAttempts += 1;
            if (addColumnAttempts === 1) {
              // 另一实例已抢先完成等价变更（列 + CHECK 均已就绪）。
              if (opts.convergeToFinal) {
                reasonCols = ['reason'];
                clause = failedClause;
              }
              throw Object.assign(new Error('duplicate column'), { code: 'ER_DUP_FIELDNAME', errno: 1060 });
            }
          }
          return [[], undefined];
        }
        throw new Error('unexpected sql: ' + sql);
      },
    };
    return db;
  }

  it('recovers when another instance already added the column and constraint', async () => {
    const db = makeRacingDb({ convergeToFinal: true });
    await expect(invoiceStatusReasonMigration.up(db)).resolves.toBeUndefined();
  });

  it('rethrows when the final state is not converged after a DDL failure', async () => {
    const db = makeRacingDb({ convergeToFinal: false });
    await expect(invoiceStatusReasonMigration.up(db)).rejects.toThrow();
  });
});