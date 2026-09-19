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