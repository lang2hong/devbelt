import { describe, expect, it } from 'vitest';
import { ResultSetParser } from './resultSetParser';

describe('SQLite 结果流解析器（纯逻辑）', () => {
  it('解析 TCL 模式单结果集', () => {
    const parser = new ResultSetParser();
    const chunk = `.open '/tmp/x.db'\nSELECT * FROM users;\n"id" "name"\n"1" "alice"\n"2" "bob"\n`;
    parser.push(chunk);
    const result = parser.done();
    expect(result).toBeDefined();
    expect(result![0].header).toEqual(['id', 'name']);
    expect(result![0].rows).toEqual([
      ['1', 'alice'],
      ['2', 'bob'],
    ]);
  });

  it('处理转义八进制转义字符', () => {
    const parser = new ResultSetParser();
    parser.push(`SELECT x;\n"x"\n"\\303\\251"\n`);
    const result = parser.done();
    expect(result![0].rows[0][0]).toBe('é');
  });
});