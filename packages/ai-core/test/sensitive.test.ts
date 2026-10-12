import { describe, expect, it } from 'vitest';
import { BINARY_CELL, REDACTED_CELL, formatRowSample, isSensitiveColumnName } from '../src/sensitive.js';

describe('isSensitiveColumnName', () => {
  it('精确命中常见敏感列名', () => {
    for (const name of ['password', 'Password', 'passwd', 'token', 'secret', 'apiKey', 'api_key', 'api-key', 'hash', 'ssn', 'credit_card']) {
      expect(isSensitiveColumnName(name), name).toBe(true);
    }
  });

  it('不做子串匹配，不误伤无辜列名', () => {
    for (const name of ['monkey', 'keyboard', 'keyword', 'user_key', 'password_hint', 'tokens_count']) {
      expect(isSensitiveColumnName(name), name).toBe(false);
    }
  });
});

describe('formatRowSample', () => {
  it('敏感列打码 / 二进制占位 / 长文本截断 / bigint 转字符串', () => {
    const sample = formatRowSample(
      ['id', 'password', 'avatar', 'note', 'count'],
      [
        {
          id: 1,
          password: 'p@ss',
          avatar: new Uint8Array([1, 2, 3]),
          note: 'x'.repeat(100),
          count: 123n,
        },
      ],
    );
    expect(sample.rowsSent).toBe(1);
    expect(sample.totalRows).toBe(1);
    expect(sample.redactedCells).toBe(1);
    expect(sample.lines[0]).toBe('# sample rows (first 1 of 1)');
    const row = JSON.parse(sample.lines[1]) as Record<string, unknown>;
    expect(row.id).toBe(1);
    expect(row.password).toBe(REDACTED_CELL);
    expect(row.avatar).toBe(BINARY_CELL);
    expect(String(row.note)).toHaveLength(65);
    expect(String(row.note).endsWith('…')).toBe(true);
    expect(row.count).toBe('123');
  });

  it('行数按 maxRows 截断并汇报总数', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const sample = formatRowSample(['id'], rows, { maxRows: 2 });
    expect(sample.rowsSent).toBe(2);
    expect(sample.totalRows).toBe(3);
    expect(sample.lines[0]).toBe('# sample rows (first 2 of 3)');
    expect(sample.lines).toHaveLength(3);
  });

  it('null / 对象 / Date 的安全序列化', () => {
    const sample = formatRowSample(
      ['a', 'b', 'c'],
      [{ a: null, b: { nested: true }, c: new Date('2026-01-02T03:04:05Z') }],
    );
    const row = JSON.parse(sample.lines[1]) as Record<string, unknown>;
    expect(row.a).toBeNull();
    expect(row.b).toBe('{"nested":true}');
    expect(row.c).toBe('2026-01-02T03:04:05.000Z');
  });
});