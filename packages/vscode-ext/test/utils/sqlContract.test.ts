import { describe, expect, it } from 'vitest';
import { splitExecutableStatements, splitSqlWithRanges } from '@db-client/core/sql';
import { splitSqlStatements } from '../../src/utils/sql';

/**
 * 跨包切分契约：编辑器适配器（`utils/sql`）与 db-core 适配器必须共享同一套词法。
 * 在**无注释**语料上两者结果应完全一致；带注释时仅差在「是否保留注释」。
 */
const COMMENT_FREE = [
  'SELECT 1; SELECT 2',
  "SELECT 'a;b'; SELECT 2",
  'SELECT $$a;b$$; SELECT 2',
  'SELECT `we;ird`; SELECT 2',
  "SELECT 'O''Brien'; SELECT 2",
  'DELETE FROM t; SELECT 1 WHERE 1=0',
];

describe('跨包切分契约（编辑器 vs db-core）', () => {
  for (const sql of COMMENT_FREE) {
    it(`结果一致: ${sql.slice(0, 34)}`, () => {
      expect(splitSqlStatements(sql)).toEqual(splitExecutableStatements(sql));
    });
  }

  it('编辑器保留注释，db-core 丢弃注释', () => {
    const sql = '-- lead\nSELECT 1';
    expect(splitSqlStatements(sql)[0]).toContain('-- lead');
    expect(splitExecutableStatements(sql)[0]).toBe('SELECT 1');
  });

  it('ranges 的文本与 splitSqlStatements 一致', () => {
    const sql = "SELECT 'a;b' FROM t; /* x;y */ SELECT 2; -- z;\nSELECT 3";
    expect(splitSqlWithRanges(sql).map((r) => r.sql)).toEqual(splitSqlStatements(sql));
  });
});