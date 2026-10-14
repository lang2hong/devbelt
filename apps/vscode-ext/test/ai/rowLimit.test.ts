import { describe, expect, it } from 'vitest';
import { ensureSelectRowLimit } from '../../src/ai/rowLimit';

describe('ensureSelectRowLimit（AI 生成 SQL 行数上限兜底）', () => {
  it('裸 SELECT → 新行追加 LIMIT 10（尾分号归一）', () => {
    expect(ensureSelectRowLimit('SELECT * FROM p_project WHERE id = 1;')).toBe(
      'SELECT * FROM p_project WHERE id = 1\nLIMIT 10',
    );
    expect(ensureSelectRowLimit('select id from t')).toBe('select id from t\nLIMIT 10');
  });

  it('注释开头 / WITH 查询 → 仍追加；WITH 写语句不追加', () => {
    expect(ensureSelectRowLimit('-- 查询\nSELECT 1')).toBe('-- 查询\nSELECT 1\nLIMIT 10');
    expect(ensureSelectRowLimit('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(
      'WITH x AS (SELECT 1) SELECT * FROM x\nLIMIT 10',
    );
    expect(ensureSelectRowLimit('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toBe(
      'WITH x AS (SELECT 1) UPDATE t SET a = 1',
    );
    expect(ensureSelectRowLimit('WITH x AS (SELECT 1) DELETE FROM t')).toBe('WITH x AS (SELECT 1) DELETE FROM t');
  });

  it('行尾注释不吞掉 LIMIT（追加在新行）', () => {
    expect(ensureSelectRowLimit('SELECT * FROM t -- 说明')).toBe('SELECT * FROM t -- 说明\nLIMIT 10');
  });

  it('已有 LIMIT（含子查询内 LIMIT）→ 原样', () => {
    expect(ensureSelectRowLimit('SELECT 1 LIMIT 5')).toBe('SELECT 1 LIMIT 5');
    expect(ensureSelectRowLimit('SELECT * FROM (SELECT 1 LIMIT 3) t')).toBe('SELECT * FROM (SELECT 1 LIMIT 3) t');
  });

  it('已有 LIMIT 等价物（FETCH FIRST / TOP）→ 原样', () => {
    expect(ensureSelectRowLimit('SELECT * FROM t ORDER BY id FETCH FIRST 20 ROWS ONLY')).toBe(
      'SELECT * FROM t ORDER BY id FETCH FIRST 20 ROWS ONLY',
    );
    expect(ensureSelectRowLimit('SELECT TOP 5 * FROM t')).toBe('SELECT TOP 5 * FROM t');
  });

  it('非 SELECT / 多语句 / SELECT INTO / 行锁 → 原样', () => {
    expect(ensureSelectRowLimit('INSERT INTO t VALUES (1)')).toBe('INSERT INTO t VALUES (1)');
    expect(ensureSelectRowLimit('UPDATE t SET a = 1')).toBe('UPDATE t SET a = 1');
    expect(ensureSelectRowLimit('SELECT 1; SELECT 2;')).toBe('SELECT 1; SELECT 2;');
    expect(ensureSelectRowLimit('SELECT * INTO backup_t FROM t')).toBe('SELECT * INTO backup_t FROM t');
    expect(ensureSelectRowLimit('SELECT * FROM t FOR UPDATE')).toBe('SELECT * FROM t FOR UPDATE');
  });
});