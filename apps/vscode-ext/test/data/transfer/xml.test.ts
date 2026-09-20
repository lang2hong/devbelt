import { describe, expect, it } from 'vitest';
import { parseXml, serializeXml } from '../../../src/data/transfer/xml';

describe('XML 往返', () => {
  it('列名放属性，特殊/重名列往返不丢列', () => {
    const columns = ['a b', 'a_b', 'a<b'];
    const rows = [{ 'a b': '1', 'a_b': '2', 'a<b': '3' }];
    const xml = serializeXml(columns, rows);
    // 列名不再当元素名，不必改名，也不会与 `a_b` 冲突。
    expect(xml).toContain('<col name="a b">1</col>');
    expect(xml).toContain('<col name="a&lt;b">3</col>');
    expect(parseXml(xml)).toEqual([
      { 'a b': '1', 'a_b': '2', 'a<b': '3' },
    ]);
  });

  it('特殊字符值往返（导出转义、导入还原）', () => {
    const xml = serializeXml(['v'], [{ v: 'x&y <z> "q"' }]);
    expect(xml).toContain('x&amp;y &lt;z&gt; &quot;q&quot;');
    expect(parseXml(xml)).toEqual([{ v: 'x&y <z> "q"' }]);
  });

  it('NULL 与空串可区分', () => {
    const xml = serializeXml(['a', 'b'], [{ a: null, b: '' }]);
    expect(xml).toContain('<col name="a" nil="true"></col>');
    expect(xml).toContain('<col name="b"></col>');
    expect(parseXml(xml)).toEqual([{ a: null, b: '' }]);
  });

  it('兼容旧的「元素名=列名」格式', () => {
    const legacy = '<rows><row><id>1</id><name>Ada</name></row></rows>';
    expect(parseXml(legacy)).toEqual([{ id: '1', name: 'Ada' }]);
  });
});
describe('XML 流式解析', () => {
  it('分块读取与整份解析一致', async () => {
    const { streamXmlRows, readXmlSample } = await import('../../../src/data/transfer/xml');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const xml = '<?xml version="1.0"?>\n<rows>\n  <row><col name="id">1</col><col name="n">a&lt;b</col></row>\n  <row><col name="id">2</col><col name="n" nil="true"></col></row>\n</rows>\n';
    const dir = mkdtempSync(join(tmpdir(), 'xml-stream-'));
    const file = join(dir, 'd.xml');
    writeFileSync(file, xml);
    try {
      const streamed: unknown[] = [];
      for await (const row of streamXmlRows(file, 13)) streamed.push(row);
      expect(streamed).toEqual(parseXml(xml));
      const sample = await readXmlSample(file, 1);
      expect(sample.columns).toEqual(['id', 'n']);
      expect(sample.rows).toEqual([{ id: '1', n: 'a<b' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('大小写不同的 <ROW> 也能切分（不再静默丢空）', async () => {
    const { streamXmlRows } = await import('../../../src/data/transfer/xml');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const xml = '<ROWS><ROW><col name="id">1</col></ROW><ROW><col name="id">2</col></ROW></ROWS>';
    const dir = mkdtempSync(join(tmpdir(), 'xml-case-'));
    const file = join(dir, 'd.xml');
    writeFileSync(file, xml);
    try {
      const streamed: unknown[] = [];
      for await (const row of streamXmlRows(file, 8)) streamed.push(row);
      expect(streamed).toEqual([{ id: '1' }, { id: '2' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未闭合的尾行报错，而不是静默丢弃', async () => {
    const { streamXmlRows } = await import('../../../src/data/transfer/xml');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'xml-trunc-'));
    const file = join(dir, 'd.xml');
    writeFileSync(file, '<rows><row><col name="id">1</col></row><row><col name="id">2</col>');
    try {
      await expect((async () => { for await (const _ of streamXmlRows(file, 8)) void _; })()).rejects.toThrow(/unterminated <row>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
