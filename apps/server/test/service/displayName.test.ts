import { describe, expect, it } from 'vitest';
import { sanitizeDisplayName } from '../../src/modules/auth/service/displayName.js';

describe('sanitizeDisplayName', () => {
  it('trims and strips control/zero-width characters', () => {
    expect(sanitizeDisplayName('  Alice  ')).toBe('Alice');
    expect(sanitizeDisplayName('A\u200bBC\0')).toBe('ABC');
    expect(() => sanitizeDisplayName('\u0000\u0001')).toThrow(/1\.\.100/);
  });

  it('rejects empty after trimming', () => {
    expect(() => sanitizeDisplayName('   ')).toThrow(/1\.\.100/);
    expect(() => sanitizeDisplayName('')).toThrow(/1\.\.100/);
  });

  it('counts Unicode code points, not UTF-16 units', () => {
    const emoji = '😀';
    const name = emoji.repeat(100);
    expect(sanitizeDisplayName(name)).toBe(name); // 100 code points 放行
    expect(() => sanitizeDisplayName(emoji.repeat(101))).toThrow(/1\.\.100/);
  });

  it('rejects more than 100 characters and accepts exactly 100', () => {
    expect(sanitizeDisplayName('a'.repeat(100))).toBe('a'.repeat(100));
    expect(() => sanitizeDisplayName('a'.repeat(101))).toThrow(/1\.\.100/);
  });
});