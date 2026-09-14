import { describe, it, expect } from 'vitest';
import { accountRecoveryMigration } from '../../src/repository/mysql/migrations/022_account_recovery.js';

/**
 * 022 迁移并发防御门禁（多实例同时启动，均判定「未应用」而同时执行本迁移）：
 * - ALTER 抛 ER_DUP_FIELDNAME (errno 1060) 后必须复核 information_schema，
 *   全部目标列已存在方可视为成功放行；
 * - 复核仍缺列（真实冲突/权限问题等）必须原样上抛，不得静默吞掉；
 * - 其余错误码（如权限不足）不得被误判为并发竞态而吞掉。
 */

const ALL_COLUMNS = ['envelope_account_version', 'envelope_account_nonce', 'envelope_account_ct', 'envelope_account_tag', 'account_recovery_key'];

function colRows(columns: string[]): Array<{ COLUMN_NAME: string }> {
  return columns.map((c) => ({ COLUMN_NAME: c }));
}

/** 顺序可控 db：`statsColumns` 按每次 information_schema 查询依次消费。 */
function makeSequencedDb(opts: { statsColumns: string[][]; alterError?: unknown }) {
  const queries: string[] = [];
  let statsCall = 0;
  const db = {
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (sql.includes('information_schema.COLUMNS')) {
        const columns = opts.statsColumns[Math.min(statsCall, opts.statsColumns.length - 1)] ?? [];
        statsCall += 1;
        return [colRows(columns), undefined];
      }
      if (sql.includes('ALTER TABLE')) {
        if (opts.alterError) throw opts.alterError;
        return [[], undefined];
      }
      if (sql.includes('SET time_zone')) return [[], undefined];
      throw new Error('unexpected sql: ' + sql);
    },
  };
  return { db, queries };
}

describe('022_account_recovery migration concurrency guard', () => {
  it('skips ALTER entirely when all columns already exist', async () => {
    const { db, queries } = makeSequencedDb({ statsColumns: [ALL_COLUMNS] });
    await accountRecoveryMigration.up(db);
    expect(queries.some((q) => q.includes('ALTER TABLE'))).toBe(false);
  });

  it('adds only the missing columns when some already exist (partial prior run)', async () => {
    const { db, queries } = makeSequencedDb({ statsColumns: [['envelope_account_version', 'envelope_account_nonce']] });
    await accountRecoveryMigration.up(db);
    const alterSql = queries.find((q) => q.includes('ALTER TABLE'));
    expect(alterSql).toBeDefined();
    expect(alterSql).not.toContain('envelope_account_version BIGINT');
    expect(alterSql).toContain('envelope_account_ct');
    expect(alterSql).toContain('envelope_account_tag');
    expect(alterSql).toContain('account_recovery_key');
  });

  it('treats ER_DUP_FIELDNAME race as success once re-verification confirms all columns exist', async () => {
    // 首次查：一列都没有 → 尝试 ALTER 全部 5 列 → 撞上另一实例已并发建完 → 复核：全部就位。
    const dup = Object.assign(new Error('duplicate column name'), { code: 'ER_DUP_FIELDNAME', errno: 1060 });
    const { db, queries } = makeSequencedDb({ statsColumns: [[], ALL_COLUMNS], alterError: dup });
    await expect(accountRecoveryMigration.up(db)).resolves.toBeUndefined();
    expect(queries.some((q) => q.includes('ALTER TABLE'))).toBe(true);
  });

  it('re-throws ER_DUP_FIELDNAME when re-verification still finds columns missing', async () => {
    // 复核发现仍有列缺失（真实冲突，不是并发竞态）→ 必须上抛，不得吞掉。
    const dup = Object.assign(new Error('duplicate column name'), { code: 'ER_DUP_FIELDNAME', errno: 1060 });
    const { db } = makeSequencedDb({ statsColumns: [[], ['envelope_account_version']], alterError: dup });
    await expect(accountRecoveryMigration.up(db)).rejects.toBe(dup);
  });

  it('does NOT swallow unrelated errors (e.g. permission denied)', async () => {
    const denied = Object.assign(new Error('access denied'), { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 });
    const { db } = makeSequencedDb({ statsColumns: [[]], alterError: denied });
    await expect(accountRecoveryMigration.up(db)).rejects.toBe(denied);
  });

  it('creates all columns when none exist and ALTER succeeds without contention', async () => {
    const { db, queries } = makeSequencedDb({ statsColumns: [[]] });
    await accountRecoveryMigration.up(db);
    const alterSql = queries.find((q) => q.includes('ALTER TABLE'));
    expect(alterSql).toBeDefined();
    for (const col of ALL_COLUMNS) expect(alterSql).toContain(col);
  });
});
