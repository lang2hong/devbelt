import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareCellValues } from '../../webview/src/utils/gridSort';

describe('结果网格：大数精度', () => {
  it('本地排序按数值比较 19 位 ID，不因 Number 折叠判等', () => {
    expect(compareCellValues('2082672181952057345', '2082672181952057300')).toBe(1);
    expect(compareCellValues('2082672181952057300', '2082672181952057345')).toBe(-1);
    expect(compareCellValues('2082672181952057344', '2082672181952057345')).toBe(-1);
    expect(compareCellValues('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareCellValues('-9007199254740993', '-9007199254740992')).toBe(-1);
  });

  it('带标度的小数文本同样逐位比较（DECIMAL > 2^53）', () => {
    expect(compareCellValues('2082672181952057345.00', '2082672181952057344.99')).toBe(1);
    expect(compareCellValues('2082672181952057344.99', '2082672181952057345.00')).toBe(-1);
    expect(compareCellValues('-2082672181952057345.00', '-2082672181952057344.99')).toBe(-1);
    expect(compareCellValues('1.5', '1.50')).toBe(0);
    expect(compareCellValues('-0.00', '0.00')).toBe(0);
    expect(compareCellValues('1.05', '1.5')).toBe(-1);
  });

  it('空串与纯空白不被当作 0', () => {
    expect(compareCellValues('', '')).toBe(0);
    expect(compareCellValues('', '0')).not.toBe(0);
    expect(compareCellValues('  ', '0')).not.toBe(0);
  });

  it('普通数字与文本保持既有行为', () => {
    expect(compareCellValues('10', '2')).toBe(1);
    expect(compareCellValues(2, 10)).toBe(-1);
    expect(compareCellValues('a', 'b')).toBe(-1);
  });

  it('筛选/插入的数值输入不得使用 type="number"（Vue 会转 Number）', () => {
    const text = readFileSync(resolve(__dirname, '../../webview/src/components/ResultGrid.vue'), 'utf8');
    expect(text).not.toMatch(/type="number"/);
  });
});