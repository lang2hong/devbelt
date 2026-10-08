import { describe, expect, it } from 'vitest';
import { isTxControlStatement } from '../../src/sql/txControl';

describe('isTxControlStatement（导入/恢复剥离 dump 自带事务控制，H5）', () => {
  it('识别 BEGIN 变体', () => {
    for (const s of ['BEGIN', 'BEGIN;', 'BEGIN WORK', 'BEGIN TRANSACTION', 'BEGIN TRANSACTION;',
      'BEGIN ISOLATION LEVEL SERIALIZABLE', 'BEGIN ISOLATION LEVEL READ COMMITTED',
      'START TRANSACTION', 'START TRANSACTION READ WRITE', 'START TRANSACTION READ ONLY', 'START TRANSACTION;']) {
      expect(isTxControlStatement(s), s).toBe(true);
    }
  });

  it('识别 COMMIT/END 变体', () => {
    for (const s of ['COMMIT', 'COMMIT;', 'COMMIT WORK', 'COMMIT TRANSACTION',
      'COMMIT AND CHAIN', 'COMMIT AND NO CHAIN', 'COMMIT TRANSACTION AND CHAIN',
      'END', 'END WORK', 'END TRANSACTION', 'END;']) {
      expect(isTxControlStatement(s), s).toBe(true);
    }
  });

  it('识别 ROLLBACK/ABORT 变体', () => {
    for (const s of ['ROLLBACK', 'ROLLBACK;', 'ROLLBACK WORK', 'ROLLBACK TRANSACTION',
      'ROLLBACK AND CHAIN', 'ROLLBACK AND NO CHAIN', 'ABORT', 'ABORT WORK', 'ABORT TRANSACTION']) {
      expect(isTxControlStatement(s), s).toBe(true);
    }
  });

  it('大小写不敏感', () => {
    expect(isTxControlStatement('begin transaction')).toBe(true);
    expect(isTxControlStatement('Commit Work;')).toBe(true);
  });

  it('不误伤真实语句', () => {
    for (const s of ['SELECT 1', 'INSERT INTO t VALUES (1)', 'DROP TABLE t',
      'COMMIT; DROP TABLE t', 'BEGIN SELECT 1', 'CREATE TABLE t (id int)', '-- comment']) {
      expect(isTxControlStatement(s), s).toBe(false);
    }
  });
});