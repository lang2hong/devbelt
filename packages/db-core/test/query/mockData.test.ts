import { describe, expect, it } from 'vitest';
import { mockValue } from '../../src/query/mockData';
import type { ColumnMeta } from '../../src/types/meta';

const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;

function col(over: Partial<ColumnMeta>): ColumnMeta {
  return {
    name: 'c',
    simpleType: 'varchar',
    type: 'varchar(10)',
    comment: '',
    key: '',
    nullable: 'YES',
    maxLength: '',
    defaultValue: null,
    extra: '',
    isNotNull: false,
    isAutoIncrement: false,
    isUnique: false,
    ...over,
  } as ColumnMeta;
}

describe('mockValue', () => {
  it('数值类型即使列名命中语义分支也产出可入 SQL 的数值（不再裸串 active）', () => {
    const v = mockValue(col({ name: 'status', simpleType: 'double', type: 'double' }), 0, esc);
    expect(v).toMatch(/^-?\d/);
    expect(v).not.toContain("'");
    expect(v).not.toContain('active');
  });

  it('BIT/BOOL 数值列产出 0/1', () => {
    expect(['0', '1']).toContain(mockValue(col({ name: 'token', simpleType: 'bit', type: 'bit' }), 0, esc));
  });

  it('字符串语义列仍按名称生成并转义', () => {
    const v = mockValue(col({ name: 'status', simpleType: 'varchar', type: 'varchar(20)' }), 0, esc);
    expect(v).toBe("'active'");
  });

  it('整型列产出递增数字', () => {
    expect(mockValue(col({ name: 'qty', simpleType: 'int', type: 'int' }), 4, esc)).toBe('5');
  });
});