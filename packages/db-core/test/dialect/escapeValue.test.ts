import { describe, expect, it } from 'vitest';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';
import type { SqlDialect } from '../../src/dialect/sqlDialect';

/**
 * 值转义按方言分流的回归测试。
 *
 * 背景：此前全部走 `sqlstring.escape`（MySQL 反斜杠转义规则）。PostgreSQL 默认
 * `standard_conforming_strings=on`，反斜杠无转义语义，MySQL 规则产出的 `\'`
 * 会提前闭合字符串，形成注入点；SQLite 同理。
 */

const mysql = new MysqlDialect();
const pg = new PostgreSqlDialect();
const sqlite = new SqliteDialect();

/** 解析单引号字面量，还原数据库实际看到的字符串内容（PG/SQLite 语义：仅 '' → '）。 */
function readStandardLiteral(literal: string): string {
  expect(literal.startsWith("'")).toBe(true);
  expect(literal.endsWith("'")).toBe(true);
  return literal.slice(1, -1).replace(/''/g, "'");
}

describe('方言值转义（escapeValue）', () => {
  it('null / undefined 统一为 NULL', () => {
    for (const d of [mysql, pg, sqlite] as SqlDialect[]) {
      expect(d.escapeValue(null)).toBe('NULL');
      expect(d.escapeValue(undefined)).toBe('NULL');
    }
  });

  it('单引号在三方言中均翻倍', () => {
    expect(mysql.escapeValue("a'b")).toBe("'a''b'");
    expect(pg.escapeValue("a'b")).toBe("'a''b'");
    expect(sqlite.escapeValue("a'b")).toBe("'a''b'");
  });

  it('反斜杠仅 MySQL 翻倍，PG/SQLite 原样保留', () => {
    expect(mysql.escapeValue('a\\b')).toBe("'a\\\\b'");
    expect(pg.escapeValue('a\\b')).toBe("'a\\b'");
    expect(sqlite.escapeValue('a\\b')).toBe("'a\\b'");
  });

  it("反斜杠注入串在 PG/SQLite 下不会提前闭合字符串", () => {
    const attack = "x\\' OR 1=1 -- ";
    // PG/SQLite：反斜杠是普通字符，闭合只看单引号数量，注入的单引号已被翻倍
    for (const d of [pg, sqlite]) {
      const literal = d.escapeValue(attack);
      expect(readStandardLiteral(literal)).toBe(attack);
      // 除首尾两个引号外，内部所有引号均成对出现
      const inner = literal.slice(1, -1);
      expect(inner.replace(/''/g, '')).not.toContain("'");
    }
  });

  it('MySQL 注入串同时转义反斜杠与单引号', () => {
    const literal = mysql.escapeValue("x\\' OR 1=1 -- ");
    expect(literal).toBe("'x\\\\'' OR 1=1 -- '");
  });

  it('数字与布尔按各方言原生字面量输出', () => {
    expect(mysql.escapeValue(42)).toBe('42');
    expect(pg.escapeValue(42)).toBe('42');
    expect(sqlite.escapeValue(42)).toBe('42');

    expect(mysql.escapeValue(true)).toBe('1');
    expect(pg.escapeValue(true)).toBe('TRUE');
    expect(sqlite.escapeValue(true)).toBe('1');
  });

  it('非有限数字降级为 NULL，避免写出 Infinity/NaN 字面量', () => {
    for (const d of [mysql, pg, sqlite] as SqlDialect[]) {
      expect(d.escapeValue(Number.NaN)).toBe('NULL');
      expect(d.escapeValue(Number.POSITIVE_INFINITY)).toBe('NULL');
    }
  });

  it('对象序列化为 JSON 字面量并按方言转义', () => {
    const value = { path: 'C:\\tmp', quote: "it's" };
    expect(readStandardLiteral(pg.escapeValue(value))).toBe(JSON.stringify(value));
    expect(readStandardLiteral(sqlite.escapeValue(value))).toBe(JSON.stringify(value));
    // MySQL 额外翻倍反斜杠（JSON.stringify 已产生 \\，再翻倍为 \\\\）
    expect(mysql.escapeValue(value)).toContain('\\\\\\\\tmp');
  });

  it('Date 转 ISO 字符串字面量', () => {
    const d = new Date('2026-08-13T00:00:00.000Z');
    for (const dialect of [mysql, pg, sqlite] as SqlDialect[]) {
      expect(dialect.escapeValue(d)).toBe("'2026-08-13T00:00:00.000Z'");
    }
  });

  it('Buffer 以 hex 字面量输出，而非 JSON.stringify 损坏', () => {
    const buf = Buffer.from([0x00, 0x01, 0xde, 0xad, 0xbe, 0xef]);
    expect(mysql.escapeValue(buf)).toBe("X'0001deadbeef'");
    expect(sqlite.escapeValue(buf)).toBe("X'0001deadbeef'");
    expect(pg.escapeValue(buf)).toBe("'\\x0001deadbeef'");
  });

  it('buildInsertSql 复用同一转义规则', () => {
    const rows = [{ name: "O'Brien\\x" }];
    expect(pg.buildInsertSql(rows, ['name'], 't')).toContain("'O''Brien\\x'");
    expect(mysql.buildInsertSql(rows, ['name'], 't')).toContain("'O''Brien\\\\x'");
  });
});

describe('MySQL NO_BACKSLASH_ESCAPES 下的值转义', () => {
  const nbe = new MysqlDialect({ noBackslashEscapes: true });

  it('反斜杠不再翻倍，单引号仍翻倍', () => {
    expect(nbe.escapeValue('a\\b')).toBe("'a\\b'");
    expect(nbe.escapeValue("a'b")).toBe("'a''b'");
    // 注入形状：反斜杠是普通字符，闭合只看单引号
    expect(nbe.escapeValue("x\\' OR 1=1 -- ")).toBe("'x\\'' OR 1=1 -- '");
  });

  it('对象 JSON 同样只翻倍单引号', () => {
    const value = { path: 'C:\\tmp', quote: "it's" };
    expect(nbe.escapeValue(value)).toBe(`'${JSON.stringify(value).replace(/'/g, "''")}'`);
  });

  it('Date/Buffer/数字/布尔与默认方言一致', () => {
    expect(nbe.escapeValue(new Date('2026-08-13T00:00:00.000Z'))).toBe("'2026-08-13T00:00:00.000Z'");
    expect(nbe.escapeValue(Buffer.from([0x00, 0x01, 0xde, 0xad, 0xbe, 0xef]))).toBe("X'0001deadbeef'");
    expect(nbe.escapeValue(42)).toBe('42');
    expect(nbe.escapeValue(true)).toBe('1');
  });

  it('默认方言行为不变（对照）', () => {
    expect(mysql.escapeValue('a\\b')).toBe("'a\\\\b'");
    expect(mysql.escapeValue("a'b")).toBe("'a''b'");
  });
});

describe('PG standard_conforming_strings=off 下的值转义', () => {
  const pgOff = new PostgreSqlDialect({ standardConformingStrings: false });

  it('反斜杠翻倍（off 时普通串里 `\\` 是转义字符），单引号仍翻倍', () => {
    expect(pgOff.escapeValue('a\\b')).toBe("'a\\\\b'");
    expect(pgOff.escapeValue("a'b")).toBe("'a''b'");
    expect(pgOff.escapeValue("x\\' OR 1=1 -- ")).toBe("'x\\\\'' OR 1=1 -- '");
  });

  it('对象 JSON 与 Date 同样翻倍反斜杠', () => {
    const value = { path: 'C:\\tmp', quote: "it's" };
    const json = JSON.stringify(value).replace(/'/g, "''").replace(/\\/g, '\\\\');
    expect(pgOff.escapeValue(value)).toBe(`'${json}'`);
  });

  it('默认（on）方言行为不变（对照）', () => {
    expect(pg.escapeValue('a\\b')).toBe("'a\\b'");
    expect(pgOff.escapeValue(42)).toBe('42');
  });

  it('构造器默认 on：不传选项时 standardConformingStrings=true', () => {
    expect(new PostgreSqlDialect().standardConformingStrings).toBe(true);
    expect(pgOff.standardConformingStrings).toBe(false);
  });
});
