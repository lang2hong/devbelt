import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { buildCountSql, buildTableSelect, buildCondition } from '../../src/result/tableQuerySql';
import type { FilterCondition } from '../../src/result/tableQuerySql';

describe('tableQuerySql', () => {
  it('builds a paginated SELECT with MySQL identifiers', () => {
    expect(buildTableSelect(DatabaseType.MYSQL, 'users', 'app', [], '', '', 40, 100)).toBe(
      'SELECT * FROM `app`.`users` LIMIT 100 OFFSET 40',
    );
  });

  it('builds a paginated SELECT with PostgreSQL identifiers（H1：schema 走独立形参，database 不参与限定）', () => {
    // schema 显式给出时按 schema 限定。
    expect(buildTableSelect(DatabaseType.PG, 'users', undefined, [], 'id', 'ASC', 0, 100, {}, false, 'sales')).toBe(
      'SELECT * FROM "sales"."users" ORDER BY "id" ASC LIMIT 100 OFFSET 0',
    );
    // 未给 schema 时回退 search_path：不加限定（库名不会污染进去）。
    expect(buildTableSelect(DatabaseType.PG, 'users', 'mydb', [], 'id', 'ASC', 0, 100)).toBe(
      'SELECT * FROM "users" ORDER BY "id" ASC LIMIT 100 OFFSET 0',
    );
  });

  it('combines multiple filter conditions with AND', () => {
    const conditions: FilterCondition[] = [
      { column: 'status', op: 'eq', value: 'active' },
      { column: 'age', op: 'gte', value: '18' },
    ];
    expect(buildTableSelect(DatabaseType.MYSQL, 'users', 'app', conditions, '', '', 0, 100, { age: 'int' })).toBe(
      'SELECT * FROM `app`.`users` WHERE `status` = \'active\' AND `age` >= 18 LIMIT 100 OFFSET 0',
    );
  });

  it('supports a full set of comparison operators', () => {
    // 列 a 声明为 int，数字字面量才裸写；未声明类型的列一律加引号（见下方专门用例）
    const numeric = { a: 'int' };
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
      [{ column: 'a', op: 'in', value: '1, 2, 3' }, '`a` IN (1, 2, 3)'],
      [{ column: 'a', op: 'notIn', value: '1, 2' }, '`a` NOT IN (1, 2)'],
    ];
    for (const [condition, expected] of cases) {
      expect(buildCondition(DatabaseType.MYSQL, condition, numeric)).toBe(expected);
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

  /**
   * MySQL NO_BACKSLASH_ESCAPES：反斜杠是普通字符，字面量只翻倍单引号；
   * ESCAPE 子句也必须用单个反斜杠（`'\\'` 在该模式下是两个字符，非法）。
   */
  it('MySQL NO_BACKSLASH_ESCAPES 下不翻倍反斜杠，ESCAPE 用单反斜杠', () => {
    const eq: FilterCondition = { column: 'path', op: 'eq', value: 'C:\\tmp' };
    expect(buildCondition(DatabaseType.MYSQL, eq, {}, true)).toBe('`path` = \'C:\\tmp\'');

    const like: FilterCondition = { column: 'name', op: 'contains', value: '50%' };
    expect(buildCondition(DatabaseType.MYSQL, like, {}, true)).toBe("`name` LIKE '%50\\%%' ESCAPE '\\'");
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

/**
 * 回归：引号取决于**列类型**，不是值长得像不像数字。
 *
 * 曾经只看值：varchar 主键填 `1` 会产出 `` `id` = 1 ``，MySQL 把整列转 double 比较，
 * `'1'`/`'01'`/`' 1'`/`'1abc'` 全部命中且索引失效。
 */
describe('筛选值引号按列类型决定', () => {
  it('varchar 列填数字 → 加引号（精确字符串比较）', () => {
    const cond: FilterCondition = { column: 'id', op: 'eq', value: '1' };
    expect(buildCondition(DatabaseType.MYSQL, cond, { id: 'varchar(64)' })).toBe("`id` = '1'");
    expect(buildCondition(DatabaseType.PG, cond, { id: 'character varying' })).toBe(`"id" = '1'`);
    expect(buildCondition(DatabaseType.SQLITE, cond, { id: 'TEXT' })).toBe(`"id" = '1'`);
  });

  it('数值列填数字 → 裸写（保持索引可用）', () => {
    const cases: Array<[string, string]> = [
      ['int', '`n` = 1'],
      ['int(11) unsigned', '`n` = 1'],
      ['bigint', '`n` = 1'],
      ['tinyint(1)', '`n` = 1'],
      ['decimal(10,2)', '`n` = 1'],
      ['double precision', '`n` = 1'],
      ['numeric', '`n` = 1'],
      ['serial', '`n` = 1'],
      ['int4', '`n` = 1'],
      ['float8', '`n` = 1'],
    ];
    for (const [type, expected] of cases) {
      expect(buildCondition(DatabaseType.MYSQL, { column: 'n', op: 'eq', value: '1' }, { n: type })).toBe(expected);
    }
  });

  it('类型未知 → 加引号（安全默认：数值列会隐式转数字，语义不变）', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'id', op: 'eq', value: '1' })).toBe("`id` = '1'");
    expect(buildCondition(DatabaseType.MYSQL, { column: 'id', op: 'eq', value: '1' }, {})).toBe("`id` = '1'");
    expect(buildCondition(DatabaseType.MYSQL, { column: 'id', op: 'eq', value: '1' }, { other: 'int' })).toBe("`id` = '1'");
  });

  it('数值列填非数字 → 仍加引号（不产出非法 SQL）', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'n', op: 'eq', value: 'abc' }, { n: 'int' }))
      .toBe("`n` = 'abc'");
  });

  it('负数与小数在数值列上裸写', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'n', op: 'gt', value: '-1.5' }, { n: 'decimal(10,2)' }))
      .toBe('`n` > -1.5');
  });

  it('BETWEEN 两端同规则', () => {
    const cond: FilterCondition = { column: 'n', op: 'between', value: '1', value2: '10' };
    expect(buildCondition(DatabaseType.MYSQL, cond, { n: 'int' })).toBe('`n` BETWEEN 1 AND 10');
    expect(buildCondition(DatabaseType.MYSQL, cond, { n: 'varchar(10)' })).toBe("`n` BETWEEN '1' AND '10'");
  });

  it('IN 列表逐项同规则', () => {
    const cond: FilterCondition = { column: 'n', op: 'in', value: '1, 2, 3' };
    expect(buildCondition(DatabaseType.MYSQL, cond, { n: 'int' })).toBe('`n` IN (1, 2, 3)');
    expect(buildCondition(DatabaseType.MYSQL, cond, { n: 'varchar(10)' })).toBe("`n` IN ('1', '2', '3')");
  });

  it('IN 列表混合数字与非数字：数值列下非数字项仍加引号', () => {
    const cond: FilterCondition = { column: 'n', op: 'in', value: '1, abc' };
    expect(buildCondition(DatabaseType.MYSQL, cond, { n: 'int' })).toBe("`n` IN (1, 'abc')");
  });

  it('IN 空项被过滤，全空返回空串', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'n', op: 'in', value: ' , ,' }, { n: 'int' })).toBe('');
    expect(buildCondition(DatabaseType.MYSQL, { column: 'n', op: 'in', value: '1, , 2' }, { n: 'int' }))
      .toBe('`n` IN (1, 2)');
  });

  it('LIKE 家族不受影响（始终是字符串模式）', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'n', op: 'contains', value: '1' }, { n: 'int' }))
      .toBe("`n` LIKE '%1%' ESCAPE '\\\\'");
  });

  it('date/datetime 列填数字仍加引号（不是数值列）', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'd', op: 'eq', value: '2024' }, { d: 'datetime' }))
      .toBe("`d` = '2024'");
  });

  it('COUNT 与 SELECT 使用同一份列类型', () => {
    const conditions: FilterCondition[] = [{ column: 'id', op: 'eq', value: '1' }];
    const types = { id: 'varchar(64)' };
    expect(buildCountSql(DatabaseType.MYSQL, 't', 'db', conditions, types))
      .toBe("SELECT COUNT(*) AS total FROM `db`.`t` WHERE `id` = '1'");
    expect(buildTableSelect(DatabaseType.MYSQL, 't', 'db', conditions, '', '', 0, 100, types))
      .toBe("SELECT * FROM `db`.`t` WHERE `id` = '1' LIMIT 100 OFFSET 0");
  });
});