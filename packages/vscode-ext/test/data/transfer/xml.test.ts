import { describe, expect, it } from 'vitest';
import { serializeXml } from '../../../src/data/transfer/xml';

describe('serializeXml column-name sanitization', () => {
  it('sanitizes tag names to prevent malformed XML, escaping values', () => {
    const xml = serializeXml(['a<b', 'ok'], [{ 'a<b': 'x&y', ok: 'v' }]);
    expect(xml).toContain('<a_b>');
    expect(xml).not.toContain('<a<b>');
    expect(xml).toContain('x&amp;y');
    expect(xml).toContain('<ok>v</ok>');
  });

  it('prefixes names that do not start with a letter/underscore', () => {
    const xml = serializeXml(['9col'], [{ '9col': 'v' }]);
    expect(xml).toContain('<c_9col>');
    expect(xml).not.toContain('<9col>');
  });

  it('replaces non-ASCII characters (outside parseXml \\w range) with underscore', () => {
    const xml = serializeXml(['用户'], [{ '用户': 'v' }]);
    expect(xml).toContain('<__>');
    expect(xml).not.toContain('<用户>');
  });
});