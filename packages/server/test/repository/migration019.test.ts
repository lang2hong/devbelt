import { describe, it, expect } from 'vitest';
import { invoiceOrderUniqueMigration } from '../../src/repository/mysql/migrations/019_invoice_order_unique.js';

/**
 * 019 迁移 fail-closed 门禁：
 * - 只能吞「索引名已存在」(ER_DUP_KEYNAME / errno 1061)，且吞下后再经
 *   information_schema 复核确为 invoices(order_id) 单列唯一索引才 return；
 * - 同名但列定义错误的唯一索引（如复合 (user_id,email)）不得被误判为成功；
 * - ER_DUP_ENTRY（重复订单数据）等其余错误必须上抛，不写账本。
 */

/** 根据给定索引列构造 information_schema.STATISTICS 聚合返回。 */
function statsResult(columns: string[]): Array<{ column_count: number; only_column: string | null; first_position: number | null; last_position: number | null }> {
  return [{
    column_count: columns.length,
    only_column: columns.length === 1 ? columns[0] : null,
    first_position: columns.length ? 1 : null,
    last_position: columns.length ? columns.length : null,
  }];
}

function makeDb(opts: {
  /** information_schema.STATISTICS 查询应返回的列（[] = 不存在该唯一索引）。 */
  columns: string[];
  /** CREATE UNIQUE INDEX 是否抛错。 */
  createError?: unknown;
}) {
  const queries: string[] = [];
  const db = {
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (sql.includes('information_schema.STATISTICS')) {
        return [statsResult(opts.columns), undefined];
      }
      if (sql.includes('CREATE UNIQUE INDEX')) {
        if (opts.createError) throw opts.createError;
        return [[], undefined];
      }
      if (sql.includes('SET time_zone')) return [[], undefined];
      throw new Error('unexpected sql: ' + sql);
    },
  };
  return { db, queries };
}

/**
 * 顺序可控的 db：`statsColumns` 按每次 information_schema 查询依次消费（用于模拟
 * 「首次不存在 → CREATE 抛 ER_DUP_KEYNAME → 复核时另一个实例已建成」的竞态时序）。
 */
function makeSequencedDb(opts: {
  statsColumns: string[][];
  createError?: unknown;
}) {
  const queries: string[] = [];
  let statsCall = 0;
  const db = {
    async query(sql: string): Promise<unknown> {
      queries.push(sql);
      if (sql.includes('information_schema.STATISTICS')) {
        const columns = opts.statsColumns[Math.min(statsCall, opts.statsColumns.length - 1)] ?? [];
        statsCall += 1;
        return [statsResult(columns), undefined];
      }
      if (sql.includes('CREATE UNIQUE INDEX')) {
        if (opts.createError) throw opts.createError;
        return [[], undefined];
      }
      if (sql.includes('SET time_zone')) return [[], undefined];
      throw new Error('unexpected sql: ' + sql);
    },
  };
  return { db, queries };
}

describe('019_invoice_order_unique fail-closed', () => {
  it('skips when the exact unique index on order_id exists', async () => {
    const { db, queries } = makeDb({ columns: ['order_id'] });
    await invoiceOrderUniqueMigration.up(db);
    expect(queries.some((q) => q.includes('CREATE UNIQUE INDEX'))).toBe(false);
  });

  it('fails when a same-named unique index exists on the wrong column', async () => {
    // 同名唯一，但列是 user_id → 必须判失败并尝试重建（重建会 ER_DUP_KEYNAME，最终上抛）。
    const dupName = Object.assign(new Error('dup key name'), { errno: 1061 });
    const { db } = makeDb({ columns: ['user_id'], createError: dupName });
    await expect(invoiceOrderUniqueMigration.up(db)).rejects.toBe(dupName);
  });

  it('fails when a same-named composite unique index exists', async () => {
    const dupName = Object.assign(new Error('dup key name'), { errno: 1061 });
    const { db } = makeDb({ columns: ['user_id', 'email'], createError: dupName });
    await expect(invoiceOrderUniqueMigration.up(db)).rejects.toBe(dupName);
  });

  it('treats ER_DUP_KEYNAME race: re-verifies exact index before continuing', async () => {
    // create 抛 ER_DUP_KEYNAME，复核发现索引不存在（空列）→ 上抛。
    const dupName = Object.assign(new Error('dup key name'), { errno: 1061 });
    const { db } = makeDb({ columns: [], createError: dupName });
    await expect(invoiceOrderUniqueMigration.up(db)).rejects.toBe(dupName);
  });

  it('treats ER_DUP_KEYNAME race where another instance built the correct index as success', async () => {
    // 顺序：首次查不存在（[]）→ CREATE 抛 ER_DUP_KEYNAME → 复核发现正确唯一索引已就位。
    // 该时序确保 catch 分支与严格复核真正被走到，而非被首次 hasExactUniqueIndex 短路。
    const dupName = Object.assign(new Error('dup key name'), { errno: 1061 });
    const { db, queries } = makeSequencedDb({ statsColumns: [[], ['order_id']], createError: dupName });
    await expect(invoiceOrderUniqueMigration.up(db)).resolves.toBeUndefined();
    expect(queries.some((sql) => sql.includes('CREATE UNIQUE INDEX'))).toBe(true);
  });

  it('treats ER_DUP_KEYNAME race where the re-verified index is actually wrong as failure', async () => {
    // 顺序：首次不存在 → CREATE 抛 ER_DUP_KEYNAME → 复核发现同名唯一但列错误(user_id) → 仍失败。
    const dupName = Object.assign(new Error('dup key name'), { errno: 1061 });
    const { db, queries } = makeSequencedDb({ statsColumns: [[], ['user_id']], createError: dupName });
    await expect(invoiceOrderUniqueMigration.up(db)).rejects.toBe(dupName);
    expect(queries.some((sql) => sql.includes('CREATE UNIQUE INDEX'))).toBe(true);
  });

  it('does NOT swallow ER_DUP_ENTRY (duplicate order_id data)', async () => {
    const dupEntry = Object.assign(new Error('duplicate entry'), { errno: 1062 });
    const { db } = makeDb({ columns: [], createError: dupEntry });
    await expect(invoiceOrderUniqueMigration.up(db)).rejects.toBe(dupEntry);
  });

  it('does NOT swallow unknown errors (table missing / permission / lock timeout)', async () => {
    const unknown = Object.assign(new Error('table not found'), { errno: 1146 });
    const { db } = makeDb({ columns: [], createError: unknown });
    await expect(invoiceOrderUniqueMigration.up(db)).rejects.toBe(unknown);
  });

  it('creates the index when absent and no error occurs', async () => {
    const { db, queries } = makeDb({ columns: [] });
    await invoiceOrderUniqueMigration.up(db);
    expect(queries.some((q) => q.includes('CREATE UNIQUE INDEX'))).toBe(true);
  });
});