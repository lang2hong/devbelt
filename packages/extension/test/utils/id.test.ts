import { describe, expect, it } from 'vitest';
import { uniqueId } from '../../src/utils/id';

/**
 * 回归：同毫秒内不得碰撞。
 *
 * 曾直接用 `q-${Date.now()}` / `g-${Date.now()}`，连续 5 次只产出 1 个唯一值。
 * 碰撞后按 id 覆盖的写入（memento 数组、同步的 mergeById）会丢记录。
 */
describe('uniqueId', () => {
  it('同一毫秒内连续生成互不相同', () => {
    const ids = Array.from({ length: 500 }, () => uniqueId('q'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('保留前缀', () => {
    expect(uniqueId('q')).toMatch(/^q-\d+-\d+$/);
    expect(uniqueId('qf')).toMatch(/^qf-\d+-\d+$/);
    expect(uniqueId('g')).toMatch(/^g-\d+-\d+$/);
  });

  it('不同前缀之间不会撞', () => {
    const a = Array.from({ length: 100 }, () => uniqueId('q'));
    const b = Array.from({ length: 100 }, () => uniqueId('qf'));
    expect(new Set([...a, ...b]).size).toBe(200);
  });

  it('计数器单调递增（同毫秒内可排序）', () => {
    const [first, second] = [uniqueId('x'), uniqueId('x')];
    const n1 = Number(first.split('-')[2]);
    const n2 = Number(second.split('-')[2]);
    expect(n2).toBeGreaterThan(n1);
  });

  it('时间戳部分是当前时间（可读、可粗排序）', () => {
    const before = Date.now();
    const ts = Number(uniqueId('x').split('-')[1]);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
