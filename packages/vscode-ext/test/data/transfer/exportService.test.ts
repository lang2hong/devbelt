import { describe, expect, it } from 'vitest';
import { exportRows, exportTable } from '../../../src/data/transfer/exportService';

describe('exportRows', () => {
  const rows = [{ id: 1, name: 'Ada' }];

  it('delegates CSV and JSON rendering to the transfer codecs', () => {
    expect(exportRows({ format: 'csv', columns: ['id', 'name'], rows })).toBe('id,name\r\n1,Ada\r\n');
    expect(exportRows({ format: 'json', columns: ['name'], rows })).toBe('[\n  {\n    "name": "Ada"\n  }\n]\n');
  });

  it('requires table context for dialect-specific SQL', () => {
    expect(() => exportRows({ format: 'sql', columns: ['id'], rows })).toThrow('target table');
  });

  it('does not query table rows for a structure-only SQL export', async () => {
    const query = { query: async () => { throw new Error('data should not be queried'); }, dialect: {
      dbType: 'MYSQL' as const,
      wrap: (name: string) => `\`${name}\``,
      getPagedSql: (sql: string) => sql,
      buildInsertSql: () => '',
    } };
    const content = await exportTable({
      source: {
        query: query as any,
        metadata: { getColumns: async () => { throw new Error('columns should not be queried'); } },
        table: { getCreateSql: async () => 'CREATE TABLE `users` (`id` INT)' },
      },
      format: 'sql',
      table: 'users',
      includeStructure: true,
      includeData: false,
    });

    expect(content).toContain('DROP TABLE IF EXISTS `users`;');
    expect(content).toContain('CREATE TABLE `users` (`id` INT);');
    expect(content).toContain('SET FOREIGN_KEY_CHECKS = 0;');
    expect(content).toContain('SET FOREIGN_KEY_CHECKS = 1;');
    expect(content).not.toContain('BEGIN;');
  });

  it('exports only the selected columns', async () => {
    const seen: string[] = [];
    const query = {
      query: async (sql: string) => { seen.push(sql); return { rows: [{ id: 1, name: 'Ada', email: 'a@b.c' }], fields: [], sql, costTime: 0 }; },
      dialect: {
        dbType: 'MYSQL' as const,
        wrap: (name: string) => `\`${name}\``,
        getPagedSql: (sql: string, offset: number, limit: number) => `${sql} LIMIT ${limit} OFFSET ${offset}`,
        buildInsertSql: (_rows: Record<string, unknown>[], cols: string[]) => `INSERT ${cols.join(',')}`,
      },
    };
    const content = await exportTable({
      source: {
        query: query as any,
        metadata: { getColumns: async () => [{ name: 'id' }, { name: 'name' }, { name: 'email' }] as any },
        table: { getCreateSql: async () => '' },
      },
      format: 'sql',
      table: 'users',
      columns: ['id', 'name'],
      pageSize: 100,
    });

    expect(seen[0]).toContain('`id`, `name`');
    expect(seen[0]).not.toContain('`email`');
    expect(content).toContain('INSERT id,name');
    expect(content).toContain('BEGIN;');
    expect(content).toContain('COMMIT;');
  });
});
