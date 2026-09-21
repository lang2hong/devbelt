import { describe, expect, it } from 'vitest';
import { escapeStringLiteralContent } from '../../src/sql/escapeLiteral';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';

/**
 * 转义规则单一来源：方言 escapeValue 与编辑器侧 escapeSqlString 都调这里，
 * 防止两处各写一份而漂移。
 */
describe('escapeStringLiteralContent（转义规则单一来源）', () => {
  it('单引号一律翻倍', () => {
    expect(escapeStringLiteralContent("a'b")).toBe("a''b");
  });

  it('backslashEscapes=true：反斜杠翻倍、NUL 写成 \\0（MySQL 默认）', () => {
    expect(escapeStringLiteralContent('a\\b\0c', true)).toBe('a\\\\b\\0c');
  });

  it('backslashEscapes=false：反斜杠与 NUL 原样保留（NBE / PG / SQLite）', () => {
    expect(escapeStringLiteralContent('a\\b\0c', false)).toBe('a\\b\0c');
  });

  it('方言 escapeValue 委托同一规则', () => {
    expect(new MysqlDialect().escapeValue('a\\b')).toBe("'a\\\\b'");
    expect(new MysqlDialect({ noBackslashEscapes: true }).escapeValue('a\\b')).toBe("'a\\b'");
    expect(new PostgreSqlDialect().escapeValue("a'b")).toBe("'a''b'");
    expect(new SqliteDialect().escapeValue("a'b")).toBe("'a''b'");
  });

  it('MySQL 默认转义 NUL（此前 apps 侧漏转义，现由单一来源统一）', () => {
    expect(new MysqlDialect().escapeValue('a\0b')).toBe("'a\\0b'");
    expect(new MysqlDialect({ noBackslashEscapes: true }).escapeValue('a\0b')).toBe("'a\0b'");
  });
});