import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv, unguardFormula } from '../../../src/data/transfer/csv';

describe('CSV transfer codec', () => {
  it('round-trips commas, quotes, newlines, and typed display values', () => {
    const source = [{ id: 1, note: 'a, "quoted"\nvalue', empty: null, details: { active: true } }];
    const text = serializeCsv(['id', 'note', 'empty', 'details'], source);

    expect(text).toBe('id,note,empty,details\r\n1,"a, ""quoted""\nvalue",,"{""active"":true}"\r\n');
    expect(parseCsv(text)).toEqual({
      columns: ['id', 'note', 'empty', 'details'],
      // null 写未加引号空字段，读回仍是 null（不被当成空串）。
      rows: [{ id: '1', note: 'a, "quoted"\nvalue', empty: null, details: '{"active":true}' }],
    });
  });

  it('NULL 与空串可区分：null ↔ 空字段，空串 ↔ `""`', () => {
    const text = serializeCsv(['a', 'b'], [{ a: null, b: '' }]);
    expect(text).toBe('a,b\r\n,\"\"\r\n');
    expect(parseCsv(text)).toEqual({ columns: ['a', 'b'], rows: [{ a: null, b: '' }] });
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

describe('CSV 公式防护导入还原', () => {
  it('导出→导入往返：公式前缀被还原', () => {
    expect(unguardFormula("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(unguardFormula("'@cmd")).toBe('@cmd');
    expect(unguardFormula("'+not-a-number")).toBe('+not-a-number');
  });

  it('保留普通内容与真实前导单引号', () => {
    expect(unguardFormula('plain')).toBe('plain');
    expect(unguardFormula("'hello")).toBe("'hello");      // 非防护形态
    expect(unguardFormula("'+123")).toBe("'+123");        // 数值，非防护
  });

  it('parseCsv 应用还原', () => {
    const csv = 'a\r\n' + '"\'=1+1"';
    const parsed = parseCsv(csv, true);
    expect(parsed.rows[0].a).toBe('=1+1');
  });
});

describe('CSV 流式解析', () => {
  it('分块读取与整份解析结果一致（含跨块引号/换行）', async () => {
    const { streamCsvRows, parseCsv } = await import('../../../src/data/transfer/csv');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const sqlText = 'id,note,empty\r\n1,"a, ""quoted""\nvalue",\r\n2,plain,""\r\n'
    const dir = mkdtempSync(join(tmpdir(), 'csv-stream-'));
    const file = join(dir, 'd.csv');
    writeFileSync(file, sqlText);
    try {
      const streamed: unknown[] = [];
      for await (const row of streamCsvRows(file, true, 7)) streamed.push(row);
      expect(streamed).toEqual(parseCsv(sqlText).rows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跨块的双引号转义（""）不被误判为收尾引号', async () => {
    const { streamCsvRows } = await import('../../../src/data/transfer/csv');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const text = 'id,val\r\n1,"a""b"\r\n';
    const dir = mkdtempSync(join(tmpdir(), 'csv-quote-'));
    const file = join(dir, 'd.csv');
    writeFileSync(file, text);
    try {
      // 13 字节块恰好把 `""` 切在两个引号之间。
      const streamed: unknown[] = [];
      for await (const row of streamCsvRows(file, true, 13)) streamed.push(row);
      expect(streamed).toEqual([{ id: '1', val: 'a"b' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跳过空白行后，行对象仍带真实物理行号', async () => {
    const { streamCsvRows, CSV_ROW_LINE } = await import('../../../src/data/transfer/csv');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'csv-line-'));
    const file = join(dir, 'd.csv');
    writeFileSync(file, 'a,b\r\n1,x\r\n\r\n2,y\r\n');
    try {
      const lines: number[] = [];
      for await (const row of streamCsvRows(file, true, 4)) lines.push((row as any)[CSV_ROW_LINE]);
      // 第 3 行是空白行被跳过，第 4 行数据仍报 4（而不是映射后的 2）。
      expect(lines).toEqual([2, 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('引号内 CRLF 跨块时物理行号不多算', async () => {
    const { streamCsvRows, CSV_ROW_LINE } = await import('../../../src/data/transfer/csv');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'csv-crlf-'));
    const file = join(dir, 'd.csv');
    writeFileSync(file, 'a,b\r\n1,"x\r\ny"\r\n2,z\r\n');
    try {
      const lines: number[] = [];
      // 10 字节块会把引号内的 CRLF 切在 CR 与 LF 之间。
      for await (const row of streamCsvRows(file, true, 10)) lines.push((row as any)[CSV_ROW_LINE]);
      expect(lines).toEqual([2, 4]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readCsvSample 只取表头与样本行', async () => {
    const { readCsvSample } = await import('../../../src/data/transfer/csv');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'csv-sample-'));
    const file = join(dir, 'd.csv');
    writeFileSync(file, 'a,b\n1,x\n2,y\n3,z\n');
    try {
      const sample = await readCsvSample(file, true, 2);
      expect(sample.columns).toEqual(['a', 'b']);
      expect(sample.rows).toEqual([{ a: '1', b: 'x' }, { a: '2', b: 'y' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
