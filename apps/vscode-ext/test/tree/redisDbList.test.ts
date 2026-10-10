import { describe, expect, it } from 'vitest';
import { mergeRedisDbIndexes } from '../../src/tree/redisDbList';

/**
 * D11「DB 列表来源」：CONFIG GET databases（可用时含空库）∪ keyspace ∪ 连接默认库。
 */
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