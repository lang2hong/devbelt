import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import { escapeSqlString, splitSqlStatements, splitSqlWithRanges, wrapIdent } from '../../src/utils/sql';

describe('wrapIdent', () => {
  it('MySQL 用反引号，其余用双引号', () => {
    expect(wrapIdent(DatabaseType.MYSQL, 'users')).toBe('`users`');
    expect(wrapIdent(DatabaseType.PG, 'users')).toBe('"users"');
    expect(wrapIdent(DatabaseType.SQLITE, 'users')).toBe('"users"');
  });
});

describe('escapeSqlString', () => {
  it('单引号在所有方言都翻倍', () => {
    for (const dbType of [DatabaseType.MYSQL, DatabaseType.PG, DatabaseType.SQLITE]) {
      expect(escapeSqlString("O'Brien", dbType)).toBe("O''Brien");
    }
  });

  it('反斜杠只在 MySQL 翻倍', () => {
    expect(escapeSqlString('C:\\tmp', DatabaseType.MYSQL)).toBe('C:\\\\tmp');
    expect(escapeSqlString('C:\\tmp', DatabaseType.PG)).toBe('C:\\tmp');
    expect(escapeSqlString('C:\\tmp', DatabaseType.SQLITE)).toBe('C:\\tmp');
  });

  it('注入形状不逃出字面量', () => {
    expect(escapeSqlString("x' OR 1=1 -- ", DatabaseType.MYSQL)).toBe("x'' OR 1=1 -- ");
    expect(escapeSqlString("x' OR 1=1 -- ", DatabaseType.PG)).toBe("x'' OR 1=1 -- ");
  });

  it('dbType 是必填参数（方言差异不设默认值）', () => {
    // 编译期已强制；这里锁定运行时对三方言都给出确定结果
    for (const dbType of [DatabaseType.MYSQL, DatabaseType.PG, DatabaseType.SQLITE]) {
      expect(typeof escapeSqlString('x', dbType)).toBe('string');
    }
  });
});

/**
 * 语句切分是执行面（queryRunner / importSqlScript）与 CodeLens 共用的唯一实现。
 * CodeLens 曾自带一份不处理注释的版本，注释里的分号会把语句切成两半，
 * 导致「显示的段」与「执行的段」不一致。
 */
describe('splitSqlStatements', () => {
  it('按分号切分并去除首尾空白', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('末段无分号也收集', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('语句文本不含结尾分号', () => {
    expect(splitSqlStatements('SELECT 1;')).toEqual(['SELECT 1']);
  });

  it('空输入与纯分号返回空数组', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements(';;;')).toEqual([]);
    expect(splitSqlStatements('   \n  ')).toEqual([]);
  });

  it('单引号内的分号不切分', () => {
    expect(splitSqlStatements("SELECT 'a;b' FROM t; SELECT 2")).toEqual([
      "SELECT 'a;b' FROM t",
      'SELECT 2',
    ]);
  });

  it('双引号内的分号不切分', () => {
    expect(splitSqlStatements('SELECT "a;b" FROM t')).toEqual(['SELECT "a;b" FROM t']);
  });

  it('反引号内的分号不切分', () => {
    expect(splitSqlStatements('SELECT `we;ird` FROM t')).toEqual(['SELECT `we;ird` FROM t']);
  });

  it('行注释里的分号不切分（CodeLens 旧实现的缺陷）', () => {
    expect(splitSqlStatements('SELECT 1; -- note; more\nSELECT 2')).toEqual([
      'SELECT 1',
      '-- note; more\nSELECT 2',
    ]);
  });

  it('块注释里的分号不切分', () => {
    expect(splitSqlStatements('SELECT 1 /* a;b */; SELECT 2')).toEqual([
      'SELECT 1 /* a;b */',
      'SELECT 2',
    ]);
  });

  it('未闭合的块注释吞到末尾', () => {
    expect(splitSqlStatements('SELECT 1; /* unterminated')).toEqual(['SELECT 1', '/* unterminated']);
  });
});

describe('splitSqlWithRanges', () => {
  it('位置指向 trim 后的语句首尾', () => {
    const src = '  SELECT 1;  SELECT 2  ';
    const segs = splitSqlWithRanges(src);
    expect(segs).toHaveLength(2);
    expect(src.slice(segs[0].start, segs[0].end)).toBe('SELECT 1');
    expect(src.slice(segs[1].start, segs[1].end)).toBe('SELECT 2');
  });

  it('多行语句的位置正确（CodeLens 用它定位 Run 按钮）', () => {
    const src = 'SELECT 1;\n\nSELECT\n  2\nFROM t;';
    const segs = splitSqlWithRanges(src);
    expect(segs).toHaveLength(2);
    expect(src.slice(segs[1].start, segs[1].end)).toBe('SELECT\n  2\nFROM t');
  });

  it('sql 字段与切片一致（位置与文本不脱节）', () => {
    const src = "SELECT 'a;b'; -- c;d\nUPDATE t SET x = 1 WHERE id = 2;";
    for (const seg of splitSqlWithRanges(src)) {
      expect(src.slice(seg.start, seg.end)).toBe(seg.sql);
    }
  });

  it('与 splitSqlStatements 的文本结果一致', () => {
    const src = "SELECT 'a;b' FROM t; /* x;y */ SELECT 2; -- z;\nSELECT 3";
    expect(splitSqlWithRanges(src).map((s) => s.sql)).toEqual(splitSqlStatements(src));
  });
});
