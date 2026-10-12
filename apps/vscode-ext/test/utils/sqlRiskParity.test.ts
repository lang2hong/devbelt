import { describe, expect, it } from 'vitest';
import { analyzeSqlRisk, classifyWriteKind } from '../../src/utils/sqlRisk';
import { analyzeSqlRisk as coreAnalyze, classifyWriteKind as coreClassify } from '@devbelt/db-core/sql';

/**
 * sqlRisk 下沉零回归（P9 S6）：vscode-ext 的 `utils/sqlRisk` 是 db-core 的
 * re-export shim（AI 标签器与执行门禁共用同一实现，防两套分类器漂移）。
 * 同一引用 + 同输入同输出双重钉住。
 */
describe('sqlRisk 下沉零回归', () => {
  it('shim 是同一函数引用（非复制实现）', () => {
    expect(analyzeSqlRisk).toBe(coreAnalyze);
    expect(classifyWriteKind).toBe(coreClassify);
  });

  it('同输入同输出（read/write/critical/ddl 覆盖）', () => {
    const samples = [
      'SELECT 1',
      'SELECT * FROM t WHERE id = 1',
      'EXPLAIN SELECT 1',
      'UPDATE t SET a = 1 WHERE id = 1',
      'DELETE FROM t WHERE id = 1',
      'DELETE FROM t',
      'DROP TABLE x',
      'TRUNCATE TABLE t',
      'ALTER TABLE t ADD COLUMN c INT',
      'CREATE TABLE x (id INT)',
      "GRANT ALL ON *.* TO 'u'",
    ];
    for (const sql of samples) {
      expect(analyzeSqlRisk(sql), sql).toEqual(coreAnalyze(sql));
      expect(classifyWriteKind(sql), sql).toEqual(coreClassify(sql));
    }
  });
});