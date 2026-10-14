import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

import { formatSqlChatResult } from '../../src/ai/sqlChatResult';

describe('formatSqlChatResult（AI Chat 在对话中运行的结果回帖）', () => {
  it('结果集 → Markdown 表格（列头 + 行；null 留空；管道转义）', () => {
    const outcome = formatSqlChatResult({
      result: {
        fields: [{ name: 'id' }, { name: 'name' }],
        rows: [
          { id: 1, name: 'a|b' },
          { id: 2, name: null },
        ],
      },
      costTime: 12,
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.format).toBe('markdown');
    expect(outcome.title).toContain('2 row(s)');
    expect(outcome.title).toContain('12 ms');
    expect(outcome.content.split('\n')).toEqual([
      '| id | name |',
      '| --- | --- |',
      '| 1 | a\\|b |',
      '| 2 |  |',
    ]);
  });

  it('超过 50 行截断（标题给出真实行数，正文附截断注记）', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));
    const outcome = formatSqlChatResult({ result: { fields: [{ name: 'id' }], rows }, costTime: 5 });
    expect(outcome.title).toContain('60 row(s)');
    const lines = outcome.content.split('\n');
    expect(lines).toHaveLength(2 + 50 + 2);
    expect(lines[lines.length - 1]).toContain('60');
  });

  it('写语句（无字段）→ 仅「执行完成」标题', () => {
    const outcome = formatSqlChatResult({ result: { fields: [], rows: [] }, costTime: 8 });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toBe('');
    expect(outcome.title).toContain('8 ms');
  });

  it('错误 → 失败标题 + 错误信息', () => {
    const outcome = formatSqlChatResult({ error: new Error('Unknown column x'), costTime: 9 });
    expect(outcome.isError).toBe(true);
    expect(outcome.title.toLowerCase()).toContain('failed');
    expect(outcome.content).toBe('Unknown column x');
  });
});