import { describe, expect, it } from 'vitest';
import { importRows } from './importService';

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
});
