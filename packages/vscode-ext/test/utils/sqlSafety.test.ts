import { describe, expect, it } from 'vitest';
import { analyzeSqlRisk } from '../../src/utils/sqlRisk';

describe('analyzeSqlRisk', () => {
  it('allows read-only statements', () => {
    expect(analyzeSqlRisk('SELECT * FROM users')).toEqual({ level: 'none', isWrite: false });
  });

  it('marks an UPDATE without WHERE as critical', () => {
    expect(analyzeSqlRisk('UPDATE users SET enabled = 0')).toMatchObject({
      level: 'critical',
      isWrite: true,
      reason: 'UPDATE or DELETE without WHERE',
    });
  });

  it('marks DDL as critical after stripping comments', () => {
    expect(analyzeSqlRisk('-- cleanup\nDROP TABLE users')).toMatchObject({
      level: 'critical',
      reason: 'DDL or permission change',
    });
  });

  it('detects writes anywhere in an imported SQL script', () => {
    expect(analyzeSqlRisk('SELECT * FROM users; INSERT INTO audit_log VALUES (1)')).toMatchObject({
      level: 'write',
      isWrite: true,
    });
  });
  /**
   * 回归：字符串字面量里的关键字不得触发分类。
   *
   * 分类是全文 `\b关键字\b` 匹配，不做语法分析。曾把字面量一起看，
   * `SELECT 'DROP TABLE users'` 被判 critical + isWrite；而 confirmSqlExecution
   * 在 isWrite 为真时不早退，只读连接会直接报错拦截 —— 纯 SELECT 被禁止执行。
   */
  describe('字符串字面量中的关键字不参与分类', () => {
    const readOnlyCases = [
      "SELECT 'DROP TABLE users' AS note",
      "SELECT * FROM t WHERE name = 'ALTER'",
      "SELECT * FROM t WHERE sql_text = 'INSERT INTO x VALUES (1)'",
      `SELECT "DELETE FROM y" AS quoted`,
      "SELECT * FROM logs WHERE msg LIKE '%TRUNCATE%'",
      "SELECT 'GRANT ALL' , 'REVOKE ALL'",
    ];

    for (const sql of readOnlyCases) {
      it(`判为只读: ${sql.slice(0, 44)}`, () => {
        expect(analyzeSqlRisk(sql)).toEqual({ level: 'none', isWrite: false });
      });
    }

    it('反引号标识符里的关键字也不参与分类', () => {
      expect(analyzeSqlRisk('SELECT `drop` FROM `alter`')).toEqual({ level: 'none', isWrite: false });
    });

    it('MySQL 反斜杠转义不会提前结束字面量', () => {
      expect(analyzeSqlRisk("SELECT 'it\\'s DROP TABLE' AS s")).toEqual({ level: 'none', isWrite: false });
    });

    it('PG/SQLite 双写引号的字面量同样被剥离', () => {
      expect(analyzeSqlRisk("SELECT 'O''Brien DROP TABLE' AS s")).toEqual({ level: 'none', isWrite: false });
    });

    it('# 行注释里的关键字被剥离（MySQL 语法）', () => {
      expect(analyzeSqlRisk('SELECT 1 # DROP TABLE users')).toEqual({ level: 'none', isWrite: false });
    });

    it('剥离字面量后真实的写操作仍被识别', () => {
      expect(analyzeSqlRisk("INSERT INTO t (note) VALUES ('SELECT 1')")).toMatchObject({
        level: 'write', isWrite: true,
      });
      expect(analyzeSqlRisk("DROP TABLE t /* keep 'SELECT' */")).toMatchObject({
        level: 'critical', reason: 'DDL or permission change',
      });
      expect(analyzeSqlRisk("UPDATE t SET note = 'WHERE'")).toMatchObject({
        level: 'critical', reason: 'UPDATE or DELETE without WHERE',
      });
    });

    it('字面量替换为空格，不会粘连成新词', () => {
      // 若删除而非替空格，'DROP' + 'TABLE' 会拼成 DROPTABLE 之类的意外词
      expect(analyzeSqlRisk("SELECT 'a'||'b' FROM t")).toEqual({ level: 'none', isWrite: false });
    });

    it('未闭合的字面量不会吞掉后续语句判定（保守到行尾）', () => {
      // 未闭合引号后全部视为字面量，结果是 SELECT 部分保留 → 只读
      expect(analyzeSqlRisk("SELECT 'unterminated")).toEqual({ level: 'none', isWrite: false });
    });
  });
});