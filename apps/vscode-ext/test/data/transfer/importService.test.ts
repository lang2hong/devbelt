import { describe, expect, it } from 'vitest';
import { importRows } from '../../../src/data/transfer/importService';

function makeQuery(failSql?: string) {
  const statements: string[] = [];
  return {
    statements,
    query: async (sql: string) => {
      statements.push(sql);
      if (sql === failSql) throw new Error('duplicate key');
      return { rows: [], fields: [], sql, costTime: 0 };
    },
    dialect: {
      buildInsertSql: (rows: Record<string, unknown>[]) => `INSERT ${String(rows[0].id)}`,
    },
  };
}

describe('importRows', () => {
  const mappings = [{ source: 'source_id', target: 'id' }];

  it('writes mapped rows inside one transaction and reports progress', async () => {
    const query = makeQuery();
    const progress: number[] = [];
    const result = await importRows({
      query: query as any,
      table: 'users',
      rows: [{ source_id: 1 }, { source_id: 2 }],
      mappings,
      onProgress: ({ completed }) => progress.push(completed),
    });

    expect(result).toEqual({ imported: 2, rolledBack: false, errors: [] });
    expect(query.statements).toEqual(['BEGIN', 'INSERT 1', 'INSERT 2', 'COMMIT']);
    expect(progress).toEqual([1, 2]);
  });

  it('rolls back and identifies the first failing source row', async () => {
    const query = makeQuery('INSERT 2');
    const result = await importRows({
      query: query as any,
      table: 'users',
      rows: [{ source_id: 1 }, { source_id: 2 }],
      mappings,
    });

    expect(result).toEqual({
      imported: 0,
      rolledBack: true,
      errors: [{ row: 2, message: 'duplicate key' }],
    });
    expect(query.statements).toEqual(['BEGIN', 'INSERT 1', 'INSERT 2', 'ROLLBACK']);
  });

  it('rowOffset 让报错行号对齐源文件行（带表头）', async () => {
    const query = makeQuery('INSERT 2');
    const result = await importRows({
      query: query as any,
      table: 'users',
      rows: [{ source_id: 1 }, { source_id: 2 }],
      mappings,
      rowOffset: 1,
    });
    // 第 2 条数据失败 → 映射后第 2 条，源文件第 3 行（表头占第 1 行）。
    expect(result.errors).toEqual([{ row: 3, message: 'duplicate key' }]);
  });
});

describe('importRows (batchWrites)', () => {
  const mappings = [{ source: 'source_id', target: 'id' }];

  it('sends the whole import as a single query when the driver is per-query (SQLite)', async () => {
    const query = makeQuery();
    const result = await importRows({
      query: query as any,
      table: 'users',
      rows: [{ source_id: 1 }, { source_id: 2 }],
      mappings,
      batchWrites: true,
    });

    expect(result).toEqual({ imported: 2, rolledBack: false, errors: [] });
    expect(query.statements).toEqual(['BEGIN; INSERT 1\nINSERT 2 COMMIT;']);
  });

  it('rolls back a failed batch and reports the error', async () => {
    const query = makeQuery('BEGIN; INSERT 1\nINSERT 2 COMMIT;');
    const result = await importRows({
      query: query as any,
      table: 'users',
      rows: [{ source_id: 1 }, { source_id: 2 }],
      mappings,
      batchWrites: true,
    });

    expect(result).toEqual({
      imported: 0,
      rolledBack: true,
      errors: [{ row: 1, message: 'duplicate key' }],
    });
    expect(query.statements).toEqual(['BEGIN; INSERT 1\nINSERT 2 COMMIT;', 'ROLLBACK']);
  });
});
