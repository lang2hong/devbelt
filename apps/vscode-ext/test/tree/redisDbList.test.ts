import { describe, expect, it } from 'vitest';
import { mergeRedisDbIndexes, visibleRedisDbIndexes } from '../../src/tree/redisDbList';

/**
 * D11「DB 列表来源」：CONFIG GET databases（可用时含空库）∪ keyspace ∪ 连接默认库。
 */
describe('visibleRedisDbIndexes（树中隐藏空库）', () => {
  it('仅显示有键的库；空库不显示', () => {
    expect(visibleRedisDbIndexes([0, 3], 0)).toEqual([0, 3]);
    expect(visibleRedisDbIndexes([2], 0)).toEqual([2]);
  });

  it('整个实例为空时保留默认库，便于新建键', () => {
    expect(visibleRedisDbIndexes([], 3)).toEqual([3]);
    expect(visibleRedisDbIndexes([], -1)).toEqual([]);
  });
});

describe('mergeRedisDbIndexes', () => {
  it('CONFIG 可用：0..n-1 全列（空库可见）', () => {
    expect(mergeRedisDbIndexes([0, 2], 4, 0)).toEqual([0, 1, 2, 3]);
  });

  it('CONFIG 不可用（null）：keyspace ∪ 默认库', () => {
    expect(mergeRedisDbIndexes([2, 5], null, 0)).toEqual([0, 2, 5]);
    expect(mergeRedisDbIndexes([], null, 3)).toEqual([3]);
  });

  it('去重、排序；非法索引忽略', () => {
    expect(mergeRedisDbIndexes([9, 9, 0], 2, 0)).toEqual([0, 1, 9]);
    expect(mergeRedisDbIndexes([-1, 1.5], null, 0)).toEqual([0]);
    expect(mergeRedisDbIndexes([], null, -2)).toEqual([]);
    expect(mergeRedisDbIndexes([], 0, 0)).toEqual([0]);
  });
});