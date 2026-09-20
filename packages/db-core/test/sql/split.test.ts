import { describe, expect, it } from 'vitest';
import {
  scanOptionsForDbType,
  scanSql,
  sqlSkeleton,
  splitExecutableStatements,
  splitSqlWithRanges,
  usesDelimiterDirective,
} from '../../src/sql';
import { DatabaseType } from '../../src/types/connection';

describe('scanSql / sqlSkeleton', () => {
  it('classifies code, strings, comments, executable comments and dollar literals', () => {
    const sql = "SELECT 'a' /* c */ /*!50000 x */ $$y$$ # z";
    const kinds = scanSql(sql, { hashComment: true }).map((s) => s.kind);
    expect(kinds).toContain('string');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('execComment');
    expect(kinds).toContain('dollar');
  });

  it('skeleton blanks literals/comments but keeps executable comment content', () => {
    expect(sqlSkeleton("SELECT 'DROP'")).not.toContain('DROP');
    expect(sqlSkeleton('/*!50000 DROP TABLE t */')).toContain('DROP TABLE t');
    expect(sqlSkeleton('-- DROP\nSELECT 1')).not.toContain('DROP');
  });
});

describe('splitSqlWithRanges (editor adapter)', () => {
  it('preserves comments and splits on semicolons', () => {
    expect(splitSqlWithRanges('SELECT 1; -- note; more\nSELECT 2').map((r) => r.sql)).toEqual([
      'SELECT 1',
      '-- note; more\nSELECT 2',
    ]);
  });

  it('treats # as a comment only when hashComment is set (MySQL)', () => {
    expect(splitSqlWithRanges('SELECT 1 #; DROP TABLE t', { hashComment: true }).map((r) => r.sql))
      .toEqual(['SELECT 1 #; DROP TABLE t']);
    expect(splitSqlWithRanges('SELECT 1 #; DROP TABLE t').map((r) => r.sql))
      .toEqual(['SELECT 1 #', 'DROP TABLE t']);
  });

  it('supports DELIMITER (LF + CRLF) and omits the directive', () => {
    expect(splitSqlWithRanges('DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;').map((r) => r.sql))
      .toEqual(['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND']);
    expect(splitSqlWithRanges('DELIMITER $$\r\nCREATE PROCEDURE p()\r\nBEGIN\r\n  SELECT 1;\r\nEND$$\r\nDELIMITER ;').map((r) => r.sql))
      .toEqual(['CREATE PROCEDURE p()\r\nBEGIN\r\n  SELECT 1;\r\nEND']);
  });

  it('ranges point at trimmed text', () => {
    const src = '  SELECT 1;  SELECT 2  ';
    const segs = splitSqlWithRanges(src);
    expect(segs).toHaveLength(2);
    expect(src.slice(segs[0].start, segs[0].end)).toBe('SELECT 1');
    expect(src.slice(segs[1].start, segs[1].end)).toBe('SELECT 2');
  });
});

describe('splitExecutableStatements (db-core adapter)', () => {
  it('drops line/block comments and keeps executable comments', () => {
    expect(splitExecutableStatements('-- c\nSELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(splitExecutableStatements('SELECT 1; /*!50000 DROP TABLE t */')).toEqual([
      'SELECT 1',
      '/*!50000 DROP TABLE t */',
    ]);
  });

  it('treats # as code (PG operator), not a comment', () => {
    expect(splitExecutableStatements('SELECT 1 #; DROP TABLE t')).toEqual(['SELECT 1 #', 'DROP TABLE t']);
  });

  it('does not split inside quotes or dollar bodies', () => {
    expect(splitExecutableStatements("SELECT 'a;b'; SELECT 2")).toEqual(["SELECT 'a;b'", 'SELECT 2']);
    expect(splitExecutableStatements('SELECT $$a;b$$; SELECT 2')).toEqual(['SELECT $$a;b$$', 'SELECT 2']);
  });

  it('honors DELIMITER (LF + CRLF)', () => {
    expect(splitExecutableStatements('DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;'))
      .toEqual(['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND']);
    expect(splitExecutableStatements('DELIMITER $$\r\nCREATE PROCEDURE p()\r\nBEGIN\r\n  SELECT 1;\r\nEND$$\r\nDELIMITER ;'))
      .toEqual(['CREATE PROCEDURE p()\r\nBEGIN\r\n  SELECT 1;\r\nEND']);
  });
});
describe('MySQL -- 需后跟空白 / DELIMITER 字符串内不误判', () => {
  it('dashDashRequiresSpace: 1--2 是减法而非注释', () => {
    expect(sqlSkeleton('SELECT 1--2', { dashDashRequiresSpace: true })).toContain('--2');
    expect(sqlSkeleton('SELECT 1--2', { dashDashRequiresSpace: true })).not.toContain('DROP');
    // 默认（非 MySQL）仍把 -- 当注释
    expect(sqlSkeleton('SELECT 1 -- comment')).not.toContain('comment');
  });

  it('字符串里的 DELIMITER 不会关闭 PG 美元引用识别', () => {
    const sql = "SELECT 'DELIMITER x', $$a;b$$";
    const kinds = scanSql(sql).map((s) => s.kind);
    expect(kinds).toContain('dollar');
    expect(usesDelimiterDirective("SELECT 'DELIMITER x'")).toBe(false);
    expect(usesDelimiterDirective('DELIMITER $$')).toBe(true);
  });
});

describe('DELIMITER 前置注释', () => {
  it('指令前的注释不影响指令识别（editor 适配器）', () => {
    const sql = '-- note\nDELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;';
    expect(splitSqlWithRanges(sql).map((r) => r.sql)).toEqual(['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND']);
    expect(splitExecutableStatements(sql)).toEqual(['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND']);
  });
});

describe('反斜杠转义的方向性', () => {
  it("默认（SQL 标准 / PG）：\\' 结束字符串", () => {
    const sql = String.raw`SELECT 'a\'b' AS c`;
    // 标准下反斜杠是普通字符，第一个单引号在 '\'' 处结束；'b' 是新字符串。
    expect(scanSql(sql).filter((s) => s.kind === 'string').length).toBeGreaterThanOrEqual(2);
  });

  it("MySQL（backslashEscapes:true）：\\' 转义，字符串不提前结束", () => {
    const sql = String.raw`SELECT 'a\'b' AS c`;
    expect(scanSql(sql, { backslashEscapes: true }).filter((s) => s.kind === 'string')).toHaveLength(1);
  });

  it("backslashEscapes=false（PG/SQLite）：\\' 结束字符串，后续分号正常切分", () => {
    const sql = String.raw`SELECT 'a\'; DROP TABLE t; --'`;
    const stmts = splitSqlWithRanges(sql, { backslashEscapes: false }).map((r) => r.sql);
    expect(stmts.some((s) => s.includes('DROP TABLE t'))).toBe(true);
  });
});

describe('美元引用 tag 首字规则', () => {
  const kinds = (sql: string) => scanSql(sql).map((s) => s.kind);
  it('$$ / $tag$ / $t1$ 识别为 dollar', () => {
    expect(kinds('SELECT $$a;b$$')).toContain('dollar');
    expect(kinds('SELECT $tag$a;b$tag$')).toContain('dollar');
    expect(kinds('SELECT $t1$a;b$t1$')).toContain('dollar');
  });
  it('$1$ 不是美元引用（tag 不得以数字开头）', () => {
    expect(kinds('SELECT $1$; DROP TABLE t; --$1$')).not.toContain('dollar');
  });
});

describe('scanOptionsForDbType：方言扫描选项单一来源（F1 回归）', () => {
  it('MySQL / 其它方言的选项差异', () => {
    expect(scanOptionsForDbType(DatabaseType.MYSQL)).toEqual({ hashComment: true, dashDashRequiresSpace: true, backslashEscapes: true, escapeStringPrefix: false });
    expect(scanOptionsForDbType(DatabaseType.PG)).toEqual({ hashComment: false, dashDashRequiresSpace: false, backslashEscapes: false, escapeStringPrefix: true });
    expect(scanOptionsForDbType(undefined)).toEqual({ hashComment: false, dashDashRequiresSpace: false, backslashEscapes: false, escapeStringPrefix: false });
    expect(scanOptionsForDbType(DatabaseType.MYSQL, { noBackslashEscapes: true })).toEqual({ hashComment: true, dashDashRequiresSpace: true, backslashEscapes: false, escapeStringPrefix: false });
  });

  it('MySQL NO_BACKSLASH_ESCAPES：反斜杠不转义，隐藏的 DROP 被切出', () => {
    const opts = scanOptionsForDbType(DatabaseType.MYSQL, { noBackslashEscapes: true });
    expect(splitSqlWithRanges(String.raw`SELECT 'a\'; DROP TABLE t`, opts).map((r) => r.sql))
      .toEqual([String.raw`SELECT 'a\'`, 'DROP TABLE t']);
  });

  it('MySQL SHOW CREATE 里 COMMENT 的 \\\' 不会误切后续语句', () => {
    // 源库 SHOW CREATE TABLE 会把注释里的引号渲染为 \' 转义。
    const sql = String.raw`CREATE TABLE t (c INT COMMENT 'don\'t');
INSERT INTO t VALUES (1);`;
    // 标准（默认/PG）语义下反斜杠不转义：首条字符串提前结束、边界漂移，后续 INSERT 被吞。
    expect(splitExecutableStatements(sql)).toHaveLength(1);
    // MySQL 选项：正确切出两条。
    const stmts = splitExecutableStatements(sql, scanOptionsForDbType(DatabaseType.MYSQL));
    expect(stmts).toHaveLength(2);
    expect(stmts[1]).toBe('INSERT INTO t VALUES (1)');
  });
});

describe('PG E 串（escapeStringPrefix）：反斜杠引号不吞后续写语句', () => {
  const pg = scanOptionsForDbType(DatabaseType.PG);

  it('E 串内 \\\' 不闭合字符串，隐藏的 DELETE 仍被切出并进入骨架', () => {
    const sql = String.raw`SELECT E'\''; DELETE FROM t`;
    expect(splitSqlWithRanges(sql, pg).map((r) => r.sql)).toEqual([String.raw`SELECT E'\''`, 'DELETE FROM t']);
    expect(sqlSkeleton(sql, pg)).toContain('DELETE FROM t');
  });

  it('标准串里的反斜杠不转义（引号处正常闭合）', () => {
    const sql = String.raw`SELECT 'a\'; DELETE FROM t`;
    expect(splitSqlWithRanges(sql, pg).map((r) => r.sql)).toEqual([String.raw`SELECT 'a\'`, 'DELETE FROM t']);
  });

  it('E 前是指识符字符时不当作 E 串（NAME\\\' 保持原语义）', () => {
    // `NAME'...'` 不是 E 串：反斜杠不转义，引号处闭合。
    const sql = String.raw`SELECT NAME'a\'; DELETE FROM t`;
    expect(splitSqlWithRanges(sql, pg)).toHaveLength(2);
  });

  it('MySQL 选项下 backslashEscapes 仍生效（回归）', () => {
    const sql = String.raw`SELECT 'a\'; DELETE FROM t`;
    expect(splitSqlWithRanges(sql, { backslashEscapes: true })).toHaveLength(1);
  });

  it('未开启该选项时保持旧行为（仅 PG 开启）', () => {
    const sql = String.raw`SELECT E'\''; DELETE FROM t`;
    expect(splitSqlWithRanges(sql)).toHaveLength(1);
  });
});
