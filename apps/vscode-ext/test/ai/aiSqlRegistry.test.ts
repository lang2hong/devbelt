import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AiSqlRegistry } from '../../src/ai/aiSqlRegistry';

describe('AiSqlRegistry（AI SQL 归因标记）', () => {
  it('mark/isAiSql：空白与大小写归一化后命中', () => {
    const registry = new AiSqlRegistry();
    registry.mark('SELECT  *\nFROM orders');
    expect(registry.isAiSql('select * from orders')).toBe(true);
    expect(registry.isAiSql('SELECT *   FROM   orders ')).toBe(true);
    expect(registry.isAiSql('SELECT * FROM users')).toBe(false);
  });

  it('空 SQL 不入表、不命中', () => {
    const registry = new AiSqlRegistry();
    registry.mark('   ');
    expect(registry.isAiSql('')).toBe(false);
    expect(registry.isAiSql('   ')).toBe(false);
  });

  it('tryGet/tryMark/reset：未初始化时静默 no-op（对齐 AuditLogger 模式）', () => {
    AiSqlRegistry.reset();
    expect(AiSqlRegistry.tryGet()).toBeUndefined();
    expect(() => AiSqlRegistry.tryMark('SELECT 1')).not.toThrow();

    const registry = AiSqlRegistry.init();
    AiSqlRegistry.tryMark('SELECT 1');
    expect(AiSqlRegistry.tryGet()).toBe(registry);
    expect(registry.isAiSql('select 1')).toBe(true);

    AiSqlRegistry.reset();
    expect(AiSqlRegistry.tryGet()).toBeUndefined();
  });

  it('有界：超过 200 条淘汰最旧', () => {
    const registry = new AiSqlRegistry();
    for (let i = 0; i < 205; i += 1) registry.mark(`SELECT ${i}`);
    expect(registry.isAiSql('SELECT 0')).toBe(false);
    expect(registry.isAiSql('SELECT 204')).toBe(true);
  });
});