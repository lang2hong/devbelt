import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import { buildCountSql, buildTableSelect, buildCondition } from './tableQuerySql';
import type { FilterCondition } from './tableQuerySql';

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
      'SELECT * FROM `app`.`users` WHERE `status` = \'active\' AND `age` >= \'18\' LIMIT 100 OFFSET 0',
    );
  });

  it('supports a full set of comparison operators', () => {
    const cases: Array<[FilterCondition, string]> = [
      [{ column: 'a', op: 'eq', value: 'x' }, '`a` = \'x\''],
      [{ column: 'a', op: 'ne', value: 'x' }, '`a` <> \'x\''],
      [{ column: 'a', op: 'contains', value: 'x' }, '`a` LIKE \'%x%\''],
      [{ column: 'a', op: 'notContains', value: 'x' }, '`a` NOT LIKE \'%x%\''],
      [{ column: 'a', op: 'startsWith', value: 'x' }, '`a` LIKE \'x%\''],
      [{ column: 'a', op: 'endsWith', value: 'x' }, '`a` LIKE \'%x\''],
      [{ column: 'a', op: 'gt', value: 'x' }, '`a` > \'x\''],
      [{ column: 'a', op: 'gte', value: 'x' }, '`a` >= \'x\''],
      [{ column: 'a', op: 'lt', value: 'x' }, '`a` < \'x\''],
      [{ column: 'a', op: 'lte', value: 'x' }, '`a` <= \'x\''],
      [{ column: 'a', op: 'isNull' }, '`a` IS NULL'],
      [{ column: 'a', op: 'notNull' }, '`a` IS NOT NULL'],
    ];
    for (const [condition, expected] of cases) {
      expect(buildCondition(DatabaseType.MYSQL, condition)).toBe(expected);
    }
  });

  it('escapes quotes and wildcards in values', () => {
    expect(buildCondition(DatabaseType.MYSQL, { column: 'name', op: 'eq', value: "a'b" })).toBe("`name` = 'a''b'");
    expect(buildCondition(DatabaseType.MYSQL, { column: 'name', op: 'contains', value: '50%' })).toBe("`name` LIKE '%50\\%%'");
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