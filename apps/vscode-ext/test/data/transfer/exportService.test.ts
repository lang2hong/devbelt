import { describe, expect, it } from 'vitest';
import {
  exportFileName,
  exportFilters,
  exportRows,
  exportTable,
  isBinaryFormat,
  toFileBytes,
} from '../../../src/data/transfer/exportService';

const mysqlDialect = {
  dbType: 'MYSQL' as const,
  wrap: (name: string) => `\`${name}\``,
  getPagedSql: (sql: string, offset: number, limit: number) => `${sql} LIMIT ${limit} OFFSET ${offset}`,
  buildInsertSql: (rows: Record<string, unknown>[], cols: string[], table: string) =>
    rows.map(() => `INSERT INTO \`${table}\` (${cols.join(',')}) VALUES (...);`).join('\n'),
};

describe('exportRows', () => {
  const rows = [{ id: 1, name: 'Ada' }];

  it('delegates CSV and JSON rendering to the transfer codecs', () => {
    expect(exportRows({ format: 'csv', columns: ['id', 'name'], rows })).toBe('id,name\r\n1,Ada\r\n');
    expect(exportRows({ format: 'json', columns: ['name'], rows })).toBe('[\n  {\n    "name": "Ada"\n  }\n]\n');
  });

  it('requires table context for dialect-specific SQL', () => {
    expect(() => exportRows({ format: 'sql', columns: ['id'], rows })).toThrow('target table');
  });

  /**
   * xlsx 曾返回 base64 字符串，调用方一律 `Buffer.from(content, 'utf8')` 写盘，
   * 产出的 .xlsx 内容是 base64 文本，Excel 无法打开。
   */
  it('xlsx 返回二进制 Buffer 而非 base64 文本', () => {
    // xlsx 现由包内实现（Node zlib），不再是「可能缺失的可选依赖」
    const content = exportRows({ format: 'xlsx', columns: ['id', 'name'], rows });
    expect(Buffer.isBuffer(content)).toBe(true);
    // xlsx 是 zip 容器，魔数为 PK\x03\x04
    expect((content as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('isBinaryFormat 仅对 xlsx 为真', () => {
    expect(isBinaryFormat('xlsx')).toBe(true);
    for (const f of ['sql', 'csv', 'json', 'xml'] as const) {
      expect(isBinaryFormat(f)).toBe(false);
    }
  });

  it('toFileBytes 对文本与 Buffer 均产出字节', () => {
    expect(Buffer.from(toFileBytes('abc')).toString('utf8')).toBe('abc');
    const buf = Buffer.from([0x50, 0x4b]);
    expect(Buffer.from(toFileBytes(buf)).equals(buf)).toBe(true);
  });

  /**
   * 结果面板导出与表导出此前 SQL 产物结构不同：前者只有裸 INSERT，
   * 后者带 dump 头 / SET / 事务包裹。sqlDump 选项让两端一致。
   */
  it('SQL 导出可附加 dump 头与事务包裹，与表导出结构一致', () => {
    const content = exportRows({
      format: 'sql',
      columns: ['id', 'name'],
      rows,
      table: 'users',
      database: 'app',
      dialect: mysqlDialect as any,
      sqlDump: { serverInfo: { name: 'local', dbType: 'MYSQL' as any, host: 'h', port: 3306 } },
    }) as string;

    expect(content).toContain('DevBelt Dump SQL');
    expect(content).toContain('SET FOREIGN_KEY_CHECKS = 0;');
    expect(content).toContain('BEGIN;');
    expect(content).toContain('INSERT INTO `users`');
    expect(content).toContain('COMMIT;');
    expect(content).toContain('SET FOREIGN_KEY_CHECKS = 1;');
  });

  it('不传 sqlDump 时保持裸 INSERT（供 diff/剪贴板等场景）', () => {
    const content = exportRows({
      format: 'sql', columns: ['id'], rows, table: 'users', dialect: mysqlDialect as any,
    }) as string;
    expect(content).not.toContain('BEGIN;');
    expect(content).toContain('INSERT INTO `users`');
  });

  it('PG 导出不把库名当 schema 限定（database 是库名而非 schema）', () => {
    const pgDialect = {
      dbType: 'PG' as const,
      wrap: (name: string) => `"${name}"`,
      buildInsertSql: (rows: Record<string, unknown>[], cols: string[], table: string) =>
        rows.map(() => `INSERT INTO "${table}" (${cols.join(',')}) VALUES (...);`).join('\n'),
    };
    const content = exportRows({
      format: 'sql', columns: ['id'], rows, table: 'users', database: 'app',
      dialect: pgDialect as any,
      sqlDump: { serverInfo: { name: 'local', dbType: 'PG' as any, host: 'h', port: 5432 } },
    }) as string;
    // PG 上 `"app"."users"` 会把 app 当 schema 解析而失败
    expect(content).not.toContain('"app"."users"');
    expect(content).toContain('"users"');
  });

  it('dump 头里的不可信文本无法逃出注释上下文', () => {
    const content = exportRows({
      format: 'sql', columns: ['id'], rows: [], table: 'users',
      database: 'app\nDROP',
      dialect: mysqlDialect as any,
      sqlDump: { serverInfo: { name: 'n */ DROP', dbType: 'MYSQL' as any, host: 'h', port: 3306 } },
    }) as string;
    expect(content).not.toContain('*/ DROP');
    expect(content).toContain('* / DROP');
    expect(content).toContain('Source Schema         : app DROP');
  });
});

describe('导出文件名与过滤器（两端共用）', () => {
  it('文件名为 <base>.<format>', () => {
    expect(exportFileName('users', 'csv')).toBe('users.csv');
    expect(exportFileName('result', 'xlsx')).toBe('result.xlsx');
  });

  it('过滤器扩展名与格式一致', () => {
    expect(exportFilters('csv')).toEqual({ CSV: ['csv'] });
    expect(exportFilters('json')).toEqual({ JSON: ['json'] });
    expect(exportFilters('xlsx')).toEqual({ Excel: ['xlsx'] });
    expect(exportFilters('xml')).toEqual({ XML: ['xml'] });
    expect(exportFilters('txt')).toEqual({ Text: ['txt'] });
    expect(exportFilters('sql')).toEqual({ SQL: ['sql'] });
  });

  it('每个格式的过滤器扩展名与 exportFileName 后缀相同', () => {
    for (const format of ['sql', 'csv', 'json', 'xlsx', 'xml'] as const) {
      const ext = Object.values(exportFilters(format))[0][0];
      expect(exportFileName('t', format).endsWith(`.${ext}`)).toBe(true);
    }
  });

  it('清洗路径穿越与非法文件名字符', () => {
    expect(exportFileName('../evil', 'csv')).toBe('__evil.csv');
    expect(exportFileName('..', 'sql')).toBe('_.sql');
    expect(exportFileName('a/b', 'json')).toBe('a_b.json');
    expect(exportFileName('a\\b', 'csv')).toBe('a_b.csv');
    expect(exportFileName('ta:ble*?9', 'xml')).toBe('ta_ble__9.xml');
  });
});

describe('exportTable', () => {

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

  it('xlsx 全表导出返回 Buffer（不能按 utf8 写盘）', async () => {
    // 只有第一页有数据，第二页为空以终止分页循环
    let call = 0;
    const query = {
      query: async (sql: string) => ({ rows: call++ === 0 ? [{ id: 1 }, { id: 2 }] : [], fields: [], sql, costTime: 0 }),
      dialect: mysqlDialect,
    };
    const content = await exportTable({
      source: {
        query: query as any,
        metadata: { getColumns: async () => [{ name: 'id' }] as any },
        table: { getCreateSql: async () => '' },
      },
      format: 'xlsx',
      table: 'users',
      pageSize: 2,
    });
    expect(Buffer.isBuffer(content)).toBe(true);
  });
});

describe('txt 导出（制表符分隔）', () => {
  it('表头+行以 \\t 分隔、CRLF 结尾，公式前缀被抑制，制表/换行替换为空格', () => {
    const out = exportRows({
      format: 'txt',
      columns: ['id', 'name'],
      rows: [{ id: 1, name: 'a\tb' }, { id: 2, name: '=SUM(A1)' }],
    }) as string;
    expect(out).toBe("id\tname\r\n1\ta b\r\n2\t'=SUM(A1)\r\n");
  });

  it('writeTableExport 流式产出多块（含表头与数据）', async () => {
    const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    const pageSize = 1;
    const source = {
      query: {
        dialect: {
          dbType: 'MYSQL' as const,
          wrap: (n: string) => `\`${n}\``,
          getPagedSql: (sql: string, offset: number, limit: number) => `${sql} LIMIT ${limit} OFFSET ${offset}`,
          getKeysetSql: (sql: string) => `${sql} LIMIT ${pageSize}`,
        },
        query: async (sql: string) => ({ rows: sql.includes('OFFSET 0') ? [rows[0]] : sql.includes('OFFSET 1') ? [rows[1]] : [] }),
      },
      metadata: { getColumns: async () => [{ name: 'id', isPrimary: false }, { name: 'name', isPrimary: false }] },
      table: { getCreateSql: async () => 'CREATE TABLE `t` (`id` int)' },
    } as never;
    const { writeTableExport } = await import('../../../src/data/transfer/exportService');
    const chunks: string[] = [];
    await writeTableExport(
      { source, format: 'txt', table: 't', database: 'd', pageSize },
      (c) => { chunks.push(String(c)); },
    );
    expect(chunks[0]).toBe('id\tname\r\n');
    expect(chunks.join('')).toContain('1\ta\r\n');
    expect(chunks.join('')).toContain('2\tb\r\n');
    expect(chunks.length).toBeGreaterThan(2);
  });
});

it('A1：无主键导出的 OFFSET 分页带 ORDER BY（行序稳定）', async () => {
    const executed: string[] = [];
    const source = {
      query: {
        dialect: {
          dbType: 'MYSQL' as const,
          wrap: (n: string) => `\`${n}\``,
          getPagedSql: (sql: string, offset: number, limit: number) => `${sql} LIMIT ${limit} OFFSET ${offset}`,
          getKeysetSql: (sql: string) => sql,
        },
        query: async (sql: string) => { executed.push(sql); return { rows: [] }; },
      },
      metadata: { getColumns: async () => [{ name: 'id', isPrimary: false }, { name: 'name', isPrimary: false }] },
      table: { getCreateSql: async () => 'CREATE TABLE `t` (`id` int)' },
    } as never;
    const { writeTableExport } = await import('../../../src/data/transfer/exportService');
    await writeTableExport({ source, format: 'csv', table: 't', database: 'd', pageSize: 1 }, () => {});
    expect(executed[0]).toMatch(/ORDER BY `id`, `name`/);
  });

describe('writeTableExport keyset 走真实方言（不 mock getKeysetSql）', () => {
  it('有主键时生成展开式标量比较 SQL（兼容 MySQL 复合主键）', async () => {
    const { MysqlDialect } = await import('@devbelt/db-core');
    const executed: string[] = [];
    const pages: Array<Array<Record<string, unknown>>> = [[{ id: 1, name: 'a' }], [{ id: 2, name: 'b' }], []];
    const source = {
      query: {
        dialect: new MysqlDialect(),
        query: async (sql: string) => {
          executed.push(sql);
          return { rows: pages.shift() ?? [] };
        },
      },
      metadata: {
        getColumns: async () => [{ name: 'id', isPrimary: true }, { name: 'name', isPrimary: false }],
      },
      table: { getCreateSql: async () => 'CREATE TABLE `t` (`id` int)' },
    } as never;
    const { writeTableExport } = await import('../../../src/data/transfer/exportService');
    const chunks: string[] = [];
    await writeTableExport(
      { source, format: 'txt', table: 't', database: 'd', pageSize: 1 },
      (c) => { chunks.push(String(c)); },
    );
    expect(executed[0]).toContain('ORDER BY `id` LIMIT 1');
    expect(executed[1]).toMatch(/WHERE \(`id` > 1\)/);
    expect(chunks.join('')).toContain('2\tb\r\n');
  });
});

describe('CSV/TSV UTF-8 BOM（opt-in）', () => {
  const opts = { columns: ['id'], rows: [{ id: 1 }] };
  it('默认不加 BOM', () => {
    expect(exportRows({ format: 'csv', ...opts }) as string).not.toMatch(/^\uFEFF/);
    expect(exportRows({ format: 'txt', ...opts }) as string).not.toMatch(/^\uFEFF/);
  });
  it('withBom=true 时前置 BOM，且仅 csv/txt 生效', () => {
    expect(exportRows({ format: 'csv', ...opts, withBom: true }) as string).toMatch(/^\uFEFFid\r\n/);
    expect(exportRows({ format: 'txt', ...opts, withBom: true }) as string).toMatch(/^\uFEFFid\r\n/);
    expect(exportRows({ format: 'json', ...opts, withBom: true }) as string).not.toMatch(/^\uFEFF/);
  });
});
