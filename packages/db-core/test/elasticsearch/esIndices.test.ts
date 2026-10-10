import { describe, expect, it } from 'vitest';
import { parseCatIndices, sortIndexSummaries } from '../../src/elasticsearch/esIndices';

describe('parseCatIndices（P8 S3）', () => {
  it('归一化标准 cat 行', () => {
    const items = parseCatIndices([
      { index: 'users', health: 'green', status: 'open', pri: '1', rep: '0', 'docs.count': '42', 'store.size': '12kb' },
    ]);
    expect(items).toEqual([
      { name: 'users', health: 'green', status: 'open', primaryShards: 1, replicas: 0, docsCount: '42', storeSize: '12kb' },
    ]);
  });

  it('缺列/非常规值不抛错（null 兜底）', () => {
    const items = parseCatIndices([{ index: 'a' }, { index: 'b', health: 'blue', pri: 'x' }]);
    expect(items[0]).toEqual({ name: 'a', health: null, status: null, primaryShards: null, replicas: null, docsCount: null, storeSize: null });
    expect(items[1].health).toBeNull();
    expect(items[1].primaryShards).toBeNull();
  });

  it('跳过缺少 index 的行与非对象', () => {
    expect(parseCatIndices([{ health: 'green' }, null, 'x', { index: '' }])).toEqual([]);
  });

  it('非数组输入 → []', () => {
    expect(parseCatIndices(undefined)).toEqual([]);
    expect(parseCatIndices({ index: 'a' })).toEqual([]);
  });
});

describe('sortIndexSummaries（P8 S3）', () => {
  const items = [
    { name: 'zzz', health: 'red' as const, status: 'open', primaryShards: 1, replicas: 0, docsCount: null, storeSize: null },
    { name: 'aaa', health: 'yellow' as const, status: 'open', primaryShards: 1, replicas: 0, docsCount: null, storeSize: null },
    { name: 'mmm', health: 'green' as const, status: 'open', primaryShards: 1, replicas: 0, docsCount: null, storeSize: null },
    { name: 'bbb', health: null, status: 'open', primaryShards: 1, replicas: 0, docsCount: null, storeSize: null },
  ];

  it('按名称排序（默认升序）', () => {
    expect(sortIndexSummaries(items, 'name').map((i) => i.name)).toEqual(['aaa', 'bbb', 'mmm', 'zzz']);
    expect(sortIndexSummaries(items, 'name', true).map((i) => i.name)).toEqual(['zzz', 'mmm', 'bbb', 'aaa']);
  });

  it('按健康排序：green → yellow → red → 未知，同级按名称', () => {
    expect(sortIndexSummaries(items, 'health').map((i) => i.health)).toEqual(['green', 'yellow', 'red', null]);
  });

  it('不修改入参', () => {
    const before = items.map((i) => i.name);
    sortIndexSummaries(items, 'health', true);
    expect(items.map((i) => i.name)).toEqual(before);
  });
});