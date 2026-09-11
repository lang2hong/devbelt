import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv } from '../../../src/data/transfer/csv';

describe('CSV transfer codec', () => {
  it('round-trips commas, quotes, newlines, and typed display values', () => {
    const source = [{ id: 1, note: 'a, "quoted"\nvalue', empty: null, details: { active: true } }];
    const text = serializeCsv(['id', 'note', 'empty', 'details'], source);

    expect(text).toBe('id,note,empty,details\r\n1,"a, ""quoted""\nvalue",,"{""active"":true}"\r\n');
    expect(parseCsv(text)).toEqual({
      columns: ['id', 'note', 'empty', 'details'],
      rows: [{ id: '1', note: 'a, "quoted"\nvalue', empty: '', details: '{"active":true}' }],
    });
  });

  it('handles BOM and can generate source names for headerless files', () => {
    expect(parseCsv('\uFEFFfirst,last\r\nAda,Lovelace\r\n')).toEqual({
      columns: ['first', 'last'], rows: [{ first: 'Ada', last: 'Lovelace' }],
    });
    expect(parseCsv('Ada,Lovelace\nGrace,Hopper', false)).toEqual({
      columns: ['Column 1', 'Column 2'],
      rows: [
        { 'Column 1': 'Ada', 'Column 2': 'Lovelace' },
        { 'Column 1': 'Grace', 'Column 2': 'Hopper' },
      ],
    });
  });

  it('rejects malformed input that could produce ambiguous mappings', () => {
    expect(() => parseCsv('name,name\nAda,Lovelace')).toThrow('unique');
    expect(() => parseCsv('name\n"Ada')).toThrow('unterminated');
  });

  it('对公式前缀加前导单引号，防止 CSV 注入；纯数值不受影响', () => {
    const text = serializeCsv(['v'], [
      { v: '=1+1' },
      { v: '+SUM(A1:A2)' },
      { v: '-2+3' },
      { v: '@cmd' },
      { v: '\tx' },
      { v: '-5' },
      { v: '3.14' },
    ]);
    expect(text).toBe(
      "v\r\n'=1+1\r\n'+SUM(A1:A2)\r\n'-2+3\r\n'@cmd\r\n'\tx\r\n-5\r\n3.14\r\n",
    );
  });
});
