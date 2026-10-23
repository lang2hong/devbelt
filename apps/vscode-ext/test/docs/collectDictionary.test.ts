import { describe, expect, it, vi } from 'vitest';
import { collectDictionary, groupForeignKeys } from '../../src/docs/collectDictionary';

function col(name: string, extra: Record<string, unknown> = {}) {
  return { name, type: 'int', simpleType: 'int', comment: '', isNotNull: true, defaultValue: null, isPrimary: false, isAutoIncrement: false, ...extra };
}

function metadata(tables: string[], opts: { failing?: string[]; fks?: any[]; delay?: number } = {}) {
  let inFlight = 0;
  let peak = 0;
  const md = {
    getTables: vi.fn(async () => tables.map((name) => ({ name, comment: `${name} comment`, table_rows: '10' }))),
    getForeignKeys: vi.fn(async () => opts.fks ?? []),
    getColumns: vi.fn(async (t: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, opts.delay ?? 1));
      inFlight--;
      if (opts.failing?.includes(t)) throw new Error('denied');
      return [col('id', { isPrimary: true }), col('note', { isNotNull: false, defaultValue: 'x', comment: 'hi' })];
    }),
    getIndexes: vi.fn(async () => [{ name: 'PRIMARY', columns: ['id'], isUnique: true, isPrimary: true }]),
  };
  return { md, peak: () => peak };
}

describe('groupForeignKeys', () => {
  it('groups composite constraints and keeps column order', () => {
    const grouped = groupForeignKeys([
      { tableName: 'line', columnName: 'order_id', refTable: 'orders', refColumn: 'id', constraintName: 'fk_order' },
      { tableName: 'line', columnName: 'order_rev', refTable: 'orders', refColumn: 'rev', constraintName: 'fk_order' },
      { tableName: 'line', columnName: 'sku', refTable: 'items', refColumn: 'sku', constraintName: 'fk_item', refSchema: 'cat' },
    ] as any);
    expect(grouped.get('line')).toEqual([
      { name: 'fk_order', columns: ['order_id', 'order_rev'], refTable: 'orders', refColumns: ['id', 'rev'] },
      { name: 'fk_item', columns: ['sku'], refTable: 'items', refSchema: 'cat', refColumns: ['sku'] },
    ]);
  });
});

describe('collectDictionary', () => {
  it('maps metadata into the model, sorted by table name', async () => {
    const { md } = metadata(['users', 'orders'], {
      fks: [{ tableName: 'orders', columnName: 'user_id', refTable: 'users', refColumn: 'id', constraintName: 'fk_u' }],
    });
    const r = await collectDictionary(md as any, { database: 'shop', dbType: 'MYSQL', now: () => new Date('2026-10-23T00:00:00Z') });
    expect(r.model).toMatchObject({ database: 'shop', dbType: 'MYSQL', generatedAt: '2026-10-23T00:00:00.000Z', totalTables: 2, truncated: false });
    expect(r.model.tables.map((t) => t.name)).toEqual(['orders', 'users']);
    expect(r.model.tables[0]).toMatchObject({
      comment: 'orders comment',
      rowsEstimate: '10',
      foreignKeys: [{ name: 'fk_u', columns: ['user_id'], refTable: 'users', refColumns: ['id'] }],
    });
    expect(r.model.tables[0].columns[1]).toEqual({
      name: 'note', type: 'int', nullable: true, defaultValue: 'x', comment: 'hi', isPrimary: false, isAutoIncrement: false,
    });
    expect(md.getColumns).toHaveBeenCalledWith('orders', 'shop', undefined);
  });

  it('skips tables whose metadata cannot be read', async () => {
    const { md } = metadata(['a', 'b', 'c'], { failing: ['b'] });
    const r = await collectDictionary(md as any, { dbType: 'PG', schema: 'public' });
    expect(r.model.tables.map((t) => t.name)).toEqual(['a', 'c']);
    expect(r.skipped).toEqual(['b']);
    expect(r.model.schema).toBe('public');
  });

  it('bounds concurrency', async () => {
    const { md, peak } = metadata(Array.from({ length: 12 }, (_, i) => `t${i}`), { delay: 5 });
    await collectDictionary(md as any, { dbType: 'MYSQL', concurrency: 3 });
    expect(peak()).toBeLessThanOrEqual(3);
    expect(md.getColumns).toHaveBeenCalledTimes(12);
  });

  it('caps the number of tables and flags truncation', async () => {
    const { md } = metadata(Array.from({ length: 8 }, (_, i) => `t${i}`));
    const r = await collectDictionary(md as any, { dbType: 'MYSQL', maxTables: 5 });
    expect(r.model.tables).toHaveLength(5);
    expect(r.model).toMatchObject({ totalTables: 8, truncated: true });
  });

  it('reports progress and stops on cancellation', async () => {
    const { md } = metadata(Array.from({ length: 6 }, (_, i) => `t${i}`));
    const progress: number[] = [];
    let cancel = false;
    const r = await collectDictionary(md as any, {
      dbType: 'MYSQL',
      concurrency: 1,
      onProgress: (done) => { progress.push(done); if (done === 2) cancel = true; },
      isCancelled: () => cancel,
    });
    expect(r.cancelled).toBe(true);
    expect(progress).toEqual([1, 2]);
  });

  it('tolerates a foreign-key query failure', async () => {
    const { md } = metadata(['a']);
    md.getForeignKeys.mockRejectedValueOnce(new Error('no fk support'));
    const r = await collectDictionary(md as any, { dbType: 'SQLITE' });
    expect(r.model.tables[0].foreignKeys).toEqual([]);
  });
});