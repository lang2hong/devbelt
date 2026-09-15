import { describe, expect, it } from 'vitest';
import { sqlCommentSafe } from '../../src/sql';

describe('sqlCommentSafe', () => {
  it('removes control chars/newlines so `--` line comments cannot be escaped', () => {
    expect(sqlCommentSafe('a\nDROP TABLE t')).toBe('a DROP TABLE t');
    expect(sqlCommentSafe('a\r\nb')).toBe('a b');
  });

  it('neutralizes the block-comment terminator', () => {
    expect(sqlCommentSafe('x */ DROP TABLE t')).toBe('x * / DROP TABLE t');
  });

  it('handles null/undefined without throwing', () => {
    expect(sqlCommentSafe(undefined)).toBe('');
    expect(sqlCommentSafe(null)).toBe('');
  });
});