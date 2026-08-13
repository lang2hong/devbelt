import { describe, expect, it } from 'vitest';
import { toBool } from '../../src/utils/coerce';

/**
 * MysqlConnection 的 typeCast 把非日期值统一 `buffer.toString()`，
 * `information_schema` 中的布尔表达式（`non_unique = 0 AS is_unique`）
 * 到达上层是字符串 `"0"`/`"1"`。JS 里 `!!"0" === true`，直接当布尔用会
 * 让所有 0 值被判为真——这曾使表设计里每个索引的编辑/删除按钮都被禁用。
 */
describe('toBool（驱动布尔值归一化）', () => {
  it('字符串化的数值按数值语义判定', () => {
    expect(toBool('0')).toBe(false);
    expect(toBool('1')).toBe(true);
    expect(toBool(' 0 ')).toBe(false);
  });

  it('原生数值与 bigint', () => {
    expect(toBool(0)).toBe(false);
    expect(toBool(1)).toBe(true);
    expect(toBool(-1)).toBe(true);
    expect(toBool(0n)).toBe(false);
    expect(toBool(1n)).toBe(true);
  });

  it('boolean 原样返回', () => {
    expect(toBool(true)).toBe(true);
    expect(toBool(false)).toBe(false);
  });

  it('YES/NO 与 true/false 文本（大小写不敏感）', () => {
    expect(toBool('NO')).toBe(false);
    expect(toBool('no')).toBe(false);
    expect(toBool('YES')).toBe(true);
    expect(toBool('false')).toBe(false);
    expect(toBool('FALSE')).toBe(false);
    expect(toBool('true')).toBe(true);
    expect(toBool('off')).toBe(false);
  });

  it('Buffer 按首字节（MySQL BIT 列）', () => {
    expect(toBool(Buffer.from([0]))).toBe(false);
    expect(toBool(Buffer.from([1]))).toBe(true);
    expect(toBool(Buffer.alloc(0))).toBe(false);
  });

  it('空值与空串为假', () => {
    expect(toBool(null)).toBe(false);
    expect(toBool(undefined)).toBe(false);
    expect(toBool('')).toBe(false);
    expect(toBool('   ')).toBe(false);
  });

  it('其它非空字符串为真', () => {
    expect(toBool('PRI')).toBe(true);
    expect(toBool('2')).toBe(true);
  });
});
