import { describe, expect, it } from 'vitest';
import { classifyAiSql } from '../src/sqlSafety.js';

describe('classifyAiSql', () => {
  it('只读查询 → read', () => {
    const result = classifyAiSql('SELECT id FROM users WHERE id = 1');
    expect(result).toMatchObject({ label: 'read', level: 'none', isWrite: false, kind: 'other' });
  });

  it('DML → write / dml', () => {
    const result = classifyAiSql('INSERT INTO users (id) VALUES (1)');
    expect(result).toMatchObject({ label: 'write', level: 'write', isWrite: true, kind: 'dml' });
  });

  it('带 WHERE 的 UPDATE 为 write 而非 critical', () => {
    const result = classifyAiSql('UPDATE users SET name = \'x\' WHERE id = 1');
    expect(result).toMatchObject({ label: 'write', kind: 'dml' });
  });

  it('DDL → critical / ddl', () => {
    const result = classifyAiSql('CREATE TABLE t (id INT)');
    expect(result).toMatchObject({ label: 'critical', level: 'critical', isWrite: true, kind: 'ddl' });
  });

  it('无 WHERE 的 DELETE → critical', () => {
    const result = classifyAiSql('DELETE FROM users');
    expect(result).toMatchObject({ label: 'critical', isWrite: true });
    expect(result.reason).toContain('without WHERE');
  });

  it('过程体 DO $$…$$ fail-closed 为 critical', () => {
    const result = classifyAiSql('DO $$ BEGIN DELETE FROM users; END $$');
    expect(result).toMatchObject({ label: 'critical', isWrite: true });
  });

  it('MySQL 可执行注释里的 DDL 不被当惰性注释', () => {
    const result = classifyAiSql('/*!50000DROP TABLE t */');
    expect(result.label).toBe('critical');
  });

  it('扫描选项透传：hashComment 开关影响 # 后内容的判定', () => {
    const asComment = classifyAiSql('SELECT 1 # DROP TABLE t', { hashComment: true });
    expect(asComment.label).toBe('read');
    const asCode = classifyAiSql('SELECT 1 # DROP TABLE t', { hashComment: false });
    expect(asCode.label).toBe('critical');
  });
});