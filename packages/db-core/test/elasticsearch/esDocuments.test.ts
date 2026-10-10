import { describe, expect, it } from 'vitest';
import { collectMappingFields, nextSearchAfter, parseCatNodes, parseSearchResponse } from '../../src/elasticsearch/esDocuments';

describe('parseSearchResponse（P8 S4）', () => {
  it('ES7+ 形状：total 对象、hits、took/timed_out、aggregations', () => {
    const s = parseSearchResponse({
      took: 5,
      timed_out: false,
      hits: {
        total: { value: 42, relation: 'eq' },
        hits: [
          { _index: 'users', _id: '1', _score: 1.2, _source: { name: 'a' }, sort: [1] },
          { _index: 'users', _id: '2', _score: null, _source: { name: 'b' }, sort: [2] },
        ],
      },
      aggregations: { by_type: { buckets: [] } },
    });
    expect(s.total).toBe(42);
    expect(s.took).toBe(5);
    expect(s.timedOut).toBe(false);
    expect(s.hits.map((h) => h.id)).toEqual(['1', '2']);
    expect(s.hits[0]).toMatchObject({ index: 'users', score: 1.2, source: { name: 'a' }, sort: [1] });
    expect(s.hits[1].score).toBeNull();
    expect(s.hits[0]).toMatchObject({ seqNo: null, primaryTerm: null });
    expect(s.aggregations).toEqual({ by_type: { buckets: [] } });
  });

  it('_seq_no/_primary_term 归一（N2 乐观并发）', () => {
    const s = parseSearchResponse({ hits: { hits: [{ _id: '1', _source: {}, _seq_no: 7, _primary_term: 2 }] } });
    expect(s.hits[0]).toMatchObject({ seqNo: 7, primaryTerm: 2 });
  });

  it('数字形式 total（旧版）与缺字段容错', () => {
    const s = parseSearchResponse({ hits: { total: 7, hits: [] } });
    expect(s.total).toBe(7);
    expect(s.took).toBeNull();
    expect(s.timedOut).toBeNull();
    expect(s.aggregations).toBeNull();
  });

  it('跳过缺 _id 的命中；非对象输入返回空结果', () => {
    expect(parseSearchResponse({ hits: { hits: [{ _id: 'x' }, { noid: true }] } }).hits.map((h) => h.id)).toEqual(['x']);
    expect(parseSearchResponse(null)).toEqual({ hits: [], total: null, took: null, timedOut: null, aggregations: null });
  });
});

describe('nextSearchAfter（P8 S4）', () => {
  it('取最后一条的 sort；无 sort → null', () => {
    expect(nextSearchAfter([{ index: null, id: 'a', score: null, source: null, sort: [1, 'x'], seqNo: null, primaryTerm: null }])).toEqual([1, 'x']);
    expect(nextSearchAfter([{ index: null, id: 'a', score: null, source: null, sort: null, seqNo: null, primaryTerm: null }])).toBeNull();
    expect(nextSearchAfter([])).toBeNull();
  });
});

describe('parseCatNodes（P8 S4）', () => {
  it('归一化并排序', () => {
    const nodes = parseCatNodes([
      { name: 'n2', ip: '10.0.0.2', 'heap.percent': '33', 'ram.percent': '80', cpu: '5', load_1m: '0.50', 'node.role': 'dim', master: '-' },
      { name: 'n1', ip: '10.0.0.1', 'heap.percent': 10, 'ram.percent': 20, cpu: 1, load_1m: '0.10', 'node.role': 'cdfhilmrstw', master: '*' },
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['n1', 'n2']);
    expect(nodes[0]).toMatchObject({ ip: '10.0.0.1', heapPercent: 10, ramPercent: 20, cpu: 1, load1m: 0.1, master: '*' });
    expect(nodes[1].role).toBe('dim');
  });

  it('非数组/缺 name → 忽略', () => {
    expect(parseCatNodes(undefined)).toEqual([]);
    expect(parseCatNodes([{ ip: 'x' }, null])).toEqual([]);
  });
});
describe('collectMappingFields（P8：字段自动提取）', () => {
  it('嵌套 properties + 多字段 + 类型', () => {
    const fields = collectMappingFields({
      users: {
        mappings: {
          properties: {
            name: { type: 'keyword', fields: { raw: { type: 'keyword' } } },
            age: { type: 'integer' },
            address: { properties: { city: { type: 'text' }, geo: { type: 'geo_point' } } },
          },
        },
      },
    });
    expect(fields).toEqual([
      { path: 'name', type: 'keyword' },
      { path: 'name.raw', type: 'keyword' },
      { path: 'age', type: 'integer' },
      { path: 'address', type: 'object' },
      { path: 'address.city', type: 'text' },
      { path: 'address.geo', type: 'geo_point' },
    ]);
  });

  it('容错：非对象/无 mappings/空', () => {
    expect(collectMappingFields(null)).toEqual([]);
    expect(collectMappingFields('x')).toEqual([]);
    expect(collectMappingFields({ users: {} })).toEqual([]);
    expect(collectMappingFields({ users: { mappings: {} } })).toEqual([]);
  });

  it('上限截断', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) properties[`f${i}`] = { type: 'keyword' };
    const fields = collectMappingFields({ i: { mappings: { properties } } }, 5);
    expect(fields).toHaveLength(5);
  });
});
