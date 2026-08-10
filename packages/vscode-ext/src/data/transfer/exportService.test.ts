import { describe, expect, it } from 'vitest';
import { exportRows, exportTable } from './exportService';

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
  });
});
