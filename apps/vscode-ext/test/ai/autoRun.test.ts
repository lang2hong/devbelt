import { describe, expect, it } from 'vitest';
import { isAutoExecutableSql } from '../../src/ai/autoRun';

describe('isAutoExecutableSql（只读 SELECT 才自动执行，P9 红线受控例外）', () => {
  it('普通 SELECT → 自动', () => {
    expect(isAutoExecutableSql('SELECT * FROM t WHERE id = 1')).toBe(true);
    // 前导空白（含真实换行）不影响白名单判定
    expect(isAutoExecutableSql('  \nselect id, name from users order by id  ')).toBe(true);
    expect(isAutoExecutableSql('WITH c AS (SELECT 1 AS x) SELECT * FROM c')).toBe(true);
  });

  it('写语句 / DDL → 不自动（维持手动）', () => {
    expect(isAutoExecutableSql("UPDATE users SET name = 'x' WHERE id = 1")).toBe(false);
    expect(isAutoExecutableSql('DELETE FROM users WHERE id = 1')).toBe(false);
    expect(isAutoExecutableSql("INSERT INTO t (a) VALUES ('x')")).toBe(false);
    expect(isAutoExecutableSql('ALTER TABLE t ADD COLUMN c INT')).toBe(false);
    expect(isAutoExecutableSql('CREATE TABLE t2 (id INT)')).toBe(false);
    expect(isAutoExecutableSql('DROP TABLE t2')).toBe(false);
    expect(isAutoExecutableSql('TRUNCATE TABLE t')).toBe(false);
  });

  it('模板占位符（尖括号/省略号）→ 绝不自动执行', () => {
    expect(isAutoExecutableSql('SELECT t.<tenant_id>, COUNT(*) FROM <fence_table> f GROUP BY t.<tenant_id>')).toBe(false);
    expect(isAutoExecutableSql('SELECT id, name FROM users WHERE x = ...')).toBe(false);
    // 正常比较符不受影响：a < 5 / a < b 不是占位符
    expect(isAutoExecutableSql('SELECT * FROM t WHERE a < 5 AND b < c')).toBe(true);
  });

  it('高危读（如无 WHERE 全表 UPDATE 之外的风险语句）与空串 → 不自动', () => {
    expect(isAutoExecutableSql('')).toBe(false);
    expect(isAutoExecutableSql('   ')).toBe(false);
    // 无 WHERE 的批量写属于风险语句 → 不自动
    expect(isAutoExecutableSql('UPDATE users SET name = 2')).toBe(false);
  });

  it('控制语句不自动（风险分类器判 read 也不放过，形态白名单兜底）', () => {
    for (const sql of [
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
      'SET @x = 1',
      "SET SESSION sql_mode = ''",
      'USE other_db',
      'KILL 123',
      'FLUSH TABLES',
      'LOCK TABLES t READ',
      'UNLOCK TABLES',
    ]) {
      expect(isAutoExecutableSql(sql)).toBe(false);
    }
  });

  it('多语句：夹带控制语句/写语句不自动；全只读才自动', () => {
    expect(isAutoExecutableSql('SELECT 1; KILL 2')).toBe(false);
    expect(isAutoExecutableSql('SELECT 1; UPDATE t SET a = 1')).toBe(false);
    expect(isAutoExecutableSql('SELECT 1;\nSELECT 2')).toBe(true);
  });

  it('注释前缀/字符串内分号不破坏白名单口径', () => {
    expect(isAutoExecutableSql('/* 统计 */ SELECT COUNT(*) FROM t')).toBe(true);
    expect(isAutoExecutableSql("SELECT ';' AS sep FROM t")).toBe(true);
  });
});