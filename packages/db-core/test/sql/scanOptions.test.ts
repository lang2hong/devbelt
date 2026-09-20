import { describe, expect, it } from 'vitest';
import { parseNoBackslashEscapes, scanOptionsForDbType } from '../../src/sql/index';
import { DatabaseType } from '../../src/types/connection';

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
});