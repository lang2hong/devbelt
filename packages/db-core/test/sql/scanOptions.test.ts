import { describe, expect, it } from 'vitest';
import {
  parseNoBackslashEscapes,
  parseStandardConformingStringsOff,
  scanOptionsForDbType,
  scanOptionsForDialect,
} from '../../src/sql/index';
import { DatabaseType } from '../../src/types/connection';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { PostgreSqlDialect } from '../../src/dialect/postgreSqlDialect';

describe('parseNoBackslashEscapes', () => {
  it('识别 NO_BACKSLASH_ESCAPES（大小写、组合、单独）', () => {
    expect(parseNoBackslashEscapes('ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES')).toBe(true);
    expect(parseNoBackslashEscapes('no_backslash_escapes')).toBe(true);
    expect(parseNoBackslashEscapes('NO_BACKSLASH_ESCAPES')).toBe(true);
  });

  it('无该模式或空值时为 false', () => {
    expect(parseNoBackslashEscapes('STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY')).toBe(false);
    expect(parseNoBackslashEscapes('')).toBe(false);
    expect(parseNoBackslashEscapes(undefined)).toBe(false);
    expect(parseNoBackslashEscapes(null)).toBe(false);
  });

  it('与 scanOptionsForDbType 的组合语义一致（单一来源）', () => {
    const nbe = parseNoBackslashEscapes('NO_BACKSLASH_ESCAPES');
    expect(scanOptionsForDbType(DatabaseType.MYSQL, { noBackslashEscapes: nbe }).backslashEscapes).toBe(false);
    expect(scanOptionsForDbType(DatabaseType.MYSQL).backslashEscapes).toBe(true);
    expect(scanOptionsForDbType(DatabaseType.MYSQL, { noBackslashEscapes: false }).backslashEscapes).toBe(true);
  });

  it('scanOptionsForDialect 带上方言实例的 NBE 开关', () => {
    expect(scanOptionsForDialect(new MysqlDialect()).backslashEscapes).toBe(true);
    expect(scanOptionsForDialect(new MysqlDialect({ noBackslashEscapes: true })).backslashEscapes).toBe(false);
  });
});

describe('parseStandardConformingStringsOff', () => {
  it('仅 `off` 判为 true（大小写、空白）', () => {
    expect(parseStandardConformingStringsOff('off')).toBe(true);
    expect(parseStandardConformingStringsOff(' OFF ')).toBe(true);
    expect(parseStandardConformingStringsOff('on')).toBe(false);
    expect(parseStandardConformingStringsOff('')).toBe(false);
    expect(parseStandardConformingStringsOff(undefined)).toBe(false);
  });
});

describe('scanOptionsForDbType：PG standard_conforming_strings', () => {
  it('on（默认）反斜杠不转义；off 时反斜杠转义', () => {
    expect(scanOptionsForDbType(DatabaseType.PG).backslashEscapes).toBe(false);
    expect(scanOptionsForDbType(DatabaseType.PG, { standardConformingStrings: true }).backslashEscapes).toBe(false);
    expect(scanOptionsForDbType(DatabaseType.PG, { standardConformingStrings: false }).backslashEscapes).toBe(true);
    // `E'...'` 前缀识别与 SCS 无关，始终开启
    expect(scanOptionsForDbType(DatabaseType.PG, { standardConformingStrings: false }).escapeStringPrefix).toBe(true);
  });

  it('scanOptionsForDialect 带上方言实例的 SCS 开关', () => {
    expect(scanOptionsForDialect(new PostgreSqlDialect()).backslashEscapes).toBe(false);
    expect(scanOptionsForDialect(new PostgreSqlDialect({ standardConformingStrings: false })).backslashEscapes).toBe(true);
  });
});