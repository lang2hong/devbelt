import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import { buildCountSql, buildTableSelect, buildCondition } from '../../src/result/tableQuerySql';
import type { FilterCondition } from '../../src/result/tableQuerySql';

describe('tableQuerySql', () => {
  it('builds a paginated SELECT with MySQL identifiers', () => {
    expect(buildTableSelect(DatabaseType.MYSQL, 'users', 'app', [], '', '', 40, 100)).toBe(
      'SELECT * FROM `app`.`users` LIMIT 100 OFFSET 40',
    );
  });

  it('builds a paginated SELECT with PostgreSQL identifiers', () => {
    expect(buildTableSelect(DatabaseType.PG, 'users', 'public', [], 'id', 'ASC', 0, 100)).toBe(
      'SELECT * FROM "public"."users" ORDER BY "id" ASC LIMIT 100 OFFSET 0',
    );
  });

  it('combines multiple filter conditions with AND', () => {
    const conditions: FilterCondition[] = [
      { column: 'status', op: 'eq', value: 'active' },
      { column: 'age', op: 'gte', value: '18' },
    ];
    expect(buildTableSelect(DatabaseType.MYSQL, 'users', 'app', conditions, '', '', 0, 100)).toBe(
      'SELECT * FROM `app`.`users` WHERE `status` = \'active\' AND `age` >= 18 LIMIT 100 OFFSET 0',
    );
  });

  it('supports a full set of comparison operators', () => {
    const cases: Array<[FilterCondition, string]> = [
      [{ column: 'a', op: 'eq', value: 'x' }, '`a` = \'x\''],
      [{ column: 'a', op: 'ne', value: 'x' }, '`a` <> \'x\''],
      [{ column: 'a', op: 'contains', value: 'x' }, '`a` LIKE \'%x%\' ESCAPE \'\\\\\''],
      [{ column: 'a', op: 'notContains', value: 'x' }, '`a` NOT LIKE \'%x%\' ESCAPE \'\\\\\''],
      [{ column: 'a', op: 'startsWith', value: 'x' }, '`a` LIKE \'x%\' ESCAPE \'\\\\\''],
      [{ column: 'a', op: 'endsWith', value: 'x' }, '`a` LIKE \'%x\' ESCAPE \'\\\\\''],
      [{ column: 'a', op: 'gt', value: 'x' }, '`a` > \'x\''],
      [{ column: 'a', op: 'gte', value: 'x' }, '`a` >= \'x\''],
      [{ column: 'a', op: 'lt', value: 'x' }, '`a` < \'x\''],
      [{ column: 'a', op: 'lte', value: 'x' }, '`a` <= \'x\''],
      [{ column: 'a', op: 'isNull' }, '`a` IS NULL'],
      [{ column: 'a', op: 'notNull' }, '`a` IS NOT NULL'],
      [{ column: 'a', op: 'notStartsWith', value: 'x' }, '`a` NOT LIKE \'x%\' ESCAPE \'\\\\\''],
      [{ column: 'a', op: 'notEndsWith', value: 'x' }, '`a` NOT LIKE \'%x\' ESCAPE \'\\\\\''],
      [{ column: 'a', op: 'isEmpty' }, "`a` = ''"],
      [{ column: 'a', op: 'notEmpty' }, "`a` <> ''"],
      [{ column: 'a', op: 'between', value: '1', value2: '10' }, "`a` BETWEEN 1 AND 10"],
      [{ column: 'a', op: 'notBetween', value: '1', value2: '10' }, "`a` NOT BETWEEN 1 AND 10"],
      [{ column: 'a', op: 'in', value: '1, 2, 3' }, "`a` IN ('1', '2', '3')"],
      [{ column: 'a', op: 'notIn', value: '1, 2' }, "`a` NOT IN ('1', '2')"],
    ];
    for (const [condition, expected] of cases) {
      expect(buildCondition(DatabaseType.MYSQL, condition)).toBe(expected);
    }
  });

  it('returns empty IN clause when no values', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'a', op: 'in', value: '' })).toBe('');
  });

  it('escapes quotes and wildcards in values', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'name', op: 'eq', value: "a'b" })).toBe("`name` = 'a''b'");
    expect(buildCondition(DatabaseType.MYSQL, { column: 'name', op: 'contains', value: '50%' }))
      .toBe("`name` LIKE '%50\\%%' ESCAPE '\\\\'");
  });

  /**
   * 值转义与 LIKE 转义字符按方言分流：PG/SQLite 中反斜杠无字符串转义语义，
   * 照 MySQL 规则翻倍会把一个反斜杠写成两个字面反斜杠，匹配到错误的行。
   */
  it('PG/SQLite 不翻倍反斜杠，MySQL 翻倍', () => {
    const cond: FilterCondition = { column: 'path', op: 'eq', value: 'C:\\tmp' };
    expect(buildCondition(DatabaseType.MYSQL, cond)).toBe('`path` = \'C:\\\\tmp\'');
    expect(buildCondition(DatabaseType.PG, cond)).toBe('"path" = \'C:\\tmp\'');
    expect(buildCondition(DatabaseType.SQLITE, cond)).toBe('"path" = \'C:\\tmp\'');
  });

  it('单引号在所有方言中翻倍（注入串不逃出字面量）', () => {
    const cond: FilterCondition = { column: 'name', op: 'eq', value: "x\\' OR 1=1 -- " };
    expect(buildCondition(DatabaseType.PG, cond)).toBe('"name" = \'x\\\'\' OR 1=1 -- \'');
    expect(buildCondition(DatabaseType.SQLITE, cond)).toBe('"name" = \'x\\\'\' OR 1=1 -- \'');
  });

  /** SQLite 的 LIKE 没有默认转义字符，必须显式 ESCAPE 才能把 `\%` 当字面 `%`。 */
  it('LIKE 附带方言正确的 ESCAPE 子句', () => {
    const cond: FilterCondition = { column: 'name', op: 'contains', value: '50%' };
    expect(buildCondition(DatabaseType.SQLITE, cond)).toBe('"name" LIKE \'%50\\%%\' ESCAPE \'\\\'');
    expect(buildCondition(DatabaseType.PG, cond)).toBe('"name" LIKE \'%50\\%%\' ESCAPE \'\\\'');
  });

  it('IN 列表按方言转义每一项', () => {
    const cond: FilterCondition = { column: 'a', op: 'in', value: "a\\b, c'd" };
    expect(buildCondition(DatabaseType.PG, cond)).toBe(`"a" IN ('a\\b', 'c''d')`);
    expect(buildCondition(DatabaseType.MYSQL, cond)).toBe('`a` IN (\'a\\\\b\', \'c\'\'d\')');
  });

  it('skips conditions without a column', () => {
    expect(buildTableSelect(DatabaseType.MYSQL, 'users', '', [{ column: '', op: 'eq', value: 'x' }], '', '', 0, 100)).toBe(
      'SELECT * FROM `users` LIMIT 100 OFFSET 0',
    );
  });

  it('builds count SQL with the filter applied', () => {
    const conditions: FilterCondition[] = [{ column: 'status', op: 'eq', value: 'active' }];
    expect(buildCountSql(DatabaseType.MYSQL, 'users', 'app', conditions)).toBe(
      'SELECT COUNT(*) AS total FROM `app`.`users` WHERE `status` = \'active\'',
    );
  });
});