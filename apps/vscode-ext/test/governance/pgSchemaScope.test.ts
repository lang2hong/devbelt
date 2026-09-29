import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';

import { pgSchemaFor } from '../../src/utils/sql';
import { buildTableSelect } from '../../src/result/tableQuerySql';

const SRC = join(process.cwd(), 'src');

/**
 * H1 治理（行为测试）：PG 的限定只认**显式 schema**，绝不从 `database` 推断。
 * 结果面板过去用 `pgSchemaFor(conn, database)` 把库名当 schema；在「库名与某个
 * schema 同名」时会静默写到错误对象。
 */
describe('H1：PG schema 只来自显式 schema', () => {
  it('传 database=x、不传 schema → 生成的 SQL 不含 "x".', () => {
    const sql = buildTableSelect(DatabaseType.PG, 'users', 'x', [], '', '', 0, 100);
    expect(sql).toBe('SELECT * FROM "users" LIMIT 100 OFFSET 0');
    expect(sql).not.toContain('"x".');
  });

  it('显式 schema 才参与限定', () => {
    const sql = buildTableSelect(DatabaseType.PG, 'users', undefined, [], '', '', 0, 100, {}, false, 'sales');
    expect(sql).toBe('SELECT * FROM "sales"."users" LIMIT 100 OFFSET 0');
  });

  it('H3：导入 SQL 脚本在 PG 非默认 schema 下设置 search_path', () => {
    const src = readFileSync(join(SRC, 'commands', 'database.ts'), 'utf8');
    expect(src).toContain('SET LOCAL search_path TO');
    // 只在 PG 且拿到 schema 时设置，不能影响 MySQL/SQLite。
    expect(src).toMatch(/conn\.dbType === DatabaseType\.PG && schema/);
  });

  it('pgSchemaFor 只对 PG 返回 schema，其余恒 undefined', () => {
    expect(pgSchemaFor({ dbType: 'PG' } as any, 'sales')).toBe('sales');
    expect(pgSchemaFor({ dbType: 'PG' } as any, undefined)).toBeUndefined();
    expect(pgSchemaFor({ dbType: 'PG' } as any, '  ')).toBeUndefined();
    expect(pgSchemaFor({ dbType: 'MYSQL' } as any, 'x')).toBeUndefined();
    expect(pgSchemaFor({ dbType: 'SQLITE' } as any, 'x')).toBeUndefined();
  });
});