import { describe, expect, it } from 'vitest';
import { safeLimit } from '../../src/repository/sqlLimit.js';

describe('safeLimit（LIMIT 内插防护）', () => {
  it('无效值兜底为 fallback，绝不产生 LIMIT NaN', () => {
    expect(safeLimit(undefined)).toBe(50);
    expect(safeLimit(NaN)).toBe(50);
    expect(safeLimit('abc')).toBe(50);
    expect(safeLimit(0)).toBe(50);
    expect(safeLimit(-3)).toBe(50);
    expect(safeLimit(Infinity)).toBe(50);
  });

  it('合法正整数原样（不设上限，不改变既有值）', () => {
    expect(safeLimit(1)).toBe(1);
    expect(safeLimit(100)).toBe(100);
    expect(safeLimit('250')).toBe(250);
    expect(safeLimit(99999)).toBe(99999);
  });

  it('小数向下取整', () => {
    expect(safeLimit(10.9)).toBe(10);
  });
});