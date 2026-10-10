import { describe, expect, it } from 'vitest';
import { aggregationRows, aliasNames, bodyAllowedFor, detectSearchMode, docSavePath, esErrorReason, fieldSuggestions, filterJson, needsConfirm, shouldAutoLoad, textToSearchBody, validateDslBody, validateRestBody } from '../../webview/src/components/elasticsearch/types';

describe('validateRestBody（REST 控制台请求体校验）', () => {
  it('空白 → 无 body', () => {
    expect(validateRestBody('')).toEqual({ ok: true, body: null });
    expect(validateRestBody('   \n\t ')).toEqual({ ok: true, body: null });
  });

  it('合法 JSON → 原文透传（保留用户格式）', () => {
    const raw = '{\n  "query": { "match_all": {} }\n}';
    expect(validateRestBody(raw)).toEqual({ ok: true, body: raw });
    expect(validateRestBody('  [1,2]  ')).toEqual({ ok: true, body: '[1,2]' });
    expect(validateRestBody('"str"')).toEqual({ ok: true, body: '"str"' });
  });

  it('非法 JSON → ok=false', () => {
    expect(validateRestBody('{bad')).toEqual({ ok: false });
    expect(validateRestBody("{'a':1}")).toEqual({ ok: false });
  });
});
describe('aliasNames（索引别名提取）', () => {
  it('标准形状 { index: { aliases: {...} } }', () => {
    expect(aliasNames({ users: { aliases: { 'users-read': {}, 'users-all': {} } } })).toEqual(['users-all', 'users-read']);
  });

  it('异常形状 → []（不抛错）', () => {
    expect(aliasNames(null)).toEqual([]);
    expect(aliasNames('x')).toEqual([]);
    expect(aliasNames({ users: {} })).toEqual([]);
  });
});

describe('filterJson（JSON 树字段搜索）', () => {
  const mapping = {
    users: {
      mappings: {
        properties: {
          name: { type: 'keyword' },
          age: { type: 'integer' },
        },
      },
    },
  };

  it('query 为空 → 原样返回', () => {
    expect(filterJson(mapping, '')).toBe(mapping);
    expect(filterJson(mapping, '   ')).toBe(mapping);
  });

  it('按键路径保留整个子树', () => {
    expect(filterJson(mapping, 'name')).toEqual({ users: { mappings: { properties: { name: { type: 'keyword' } } } } });
  });

  it('按值命中（类型 keyword）', () => {
    const out = filterJson(mapping, 'keyword') as any;
    expect(out.users.mappings.properties.name).toEqual({ type: 'keyword' });
    expect(out.users.mappings.properties.age).toBeUndefined();
  });

  it('无命中 → undefined（UI 显示空态）', () => {
    expect(filterJson(mapping, 'zzz')).toBeUndefined();
  });

  it('数组按元素过滤，空结果剪掉', () => {
    const v = { hits: [{ field: 'a' }, { other: 1 }] };
    expect(filterJson(v, 'field')).toEqual({ hits: [{ field: 'a' }] });
  });
});

describe('aggregationRows（聚合表格化）', () => {
  it('标准 buckets → 行（key/doc_count + 其余标量列）', () => {
    const rows = aggregationRows({
      by_type: { buckets: [
        { key: 'a', doc_count: 3, avg: { value: 1.5 } },
        { key_as_string: '2024-01', key: 1, doc_count: 2, nested: { x: 1 } },
      ] },
    });
    expect(rows).toEqual([
      { agg: 'by_type', key: 'a', docCount: '3', extra: [] },
      { agg: 'by_type', key: '2024-01', docCount: '2', extra: [] },
    ]);
  });

  it('无 buckets（指标聚合）→ null（回退 JSON 树）', () => {
    expect(aggregationRows({ avg_price: { value: 12 } })).toBeNull();
    expect(aggregationRows(null)).toBeNull();
    expect(aggregationRows([{ buckets: [] }])).toBeNull();
  });

  it('空 buckets → 空数组（表格显示空态，不回退）', () => {
    expect(aggregationRows({ by_type: { buckets: [] } })).toEqual([]);
  });

  it('terms 之外的标量 bucket（range key）也能出行', () => {
    const rows = aggregationRows({ ranges: { buckets: [{ key: '*-100', doc_count: 1, from: 0, to: 100 }] } });
    expect(rows?.[0]).toEqual({ agg: 'ranges', key: '*-100', docCount: '1', extra: [['from', '0'], ['to', '100']] });
  });
});

describe('needsConfirm（索引操作确认分级）', () => {
  it('仅 close/forcemerge 需确认', () => {
    expect(needsConfirm('close')).toBe(true);
    expect(needsConfirm('forcemerge')).toBe(true);
  });

  it('open/refresh/flush/delete 不在此列（delete 由 host typed 强确认）', () => {
    for (const k of ['open', 'refresh', 'flush', 'delete', 'unknown']) {
      expect(needsConfirm(k), k).toBe(false);
    }
  });
});

describe('fieldSuggestions（字段自动补全）', () => {
  const fields = [
    { path: 'name', type: 'keyword' },
    { path: 'name.raw', type: 'keyword' },
    { path: 'age', type: 'integer' },
    { path: 'address.city', type: 'text' },
  ];

  it('空前缀 → 全部（原序）', () => {
    expect(fieldSuggestions(fields, '').map((f) => f.path)).toEqual(['name', 'name.raw', 'age', 'address.city']);
  });

  it('按路径包含过滤（不区分大小写）', () => {
    expect(fieldSuggestions(fields, 'NAME').map((f) => f.path)).toEqual(['name', 'name.raw']);
    expect(fieldSuggestions(fields, 'addr').map((f) => f.path)).toEqual(['address.city']);
  });

  it('limit 截断；无命中 → []', () => {
    expect(fieldSuggestions(fields, 'name', 1)).toHaveLength(1);
    expect(fieldSuggestions(fields, 'zzz')).toEqual([]);
  });
});

describe('搜索模式纯函数（Documents 双模式）', () => {
  it('detectSearchMode：{ 开头 → dsl（含前导空白）', () => {
    expect(detectSearchMode('{ "query": {} }')).toBe('dsl');
    expect(detectSearchMode('  {"query":{}}')).toBe('dsl');
    expect(detectSearchMode('alice AND bob')).toBe('text');
    expect(detectSearchMode('')).toBe('text');
  });

  it('textToSearchBody：文本 → 等价 query_string body', () => {
    expect(JSON.parse(textToSearchBody(' alice '))).toEqual({ query: { query_string: { query: 'alice' } } });
  });

  it('validateDslBody：仅对象 JSON 合法', () => {
    expect(validateDslBody('{"query":{"match_all":{}}}')).toBe(true);
    expect(validateDslBody('  {"size":1}  ')).toBe(true);
    expect(validateDslBody('')).toBe(false);
    expect(validateDslBody('{bad')).toBe(false);
    expect(validateDslBody('[1,2]')).toBe(false);
    expect(validateDslBody('"x"')).toBe(false);
  });
});

describe('bodyAllowedFor（REST 请求体可用性）', () => {
  it('GET/POST/PUT/DELETE/PATCH 可用；HEAD 禁用（大小写不敏感）', () => {
    for (const m of ['GET', 'get', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(bodyAllowedFor(m), m).toBe(true);
    }
    expect(bodyAllowedFor('HEAD')).toBe(false);
    expect(bodyAllowedFor('head')).toBe(false);
  });
});

describe('shouldAutoLoad（切 tab 保留现场的懒加载判定）', () => {
  const none = { indices: false, index: false, docs: false, nodes: false };
  const all = { indices: true, index: true, docs: true, nodes: true };

  it('无数据 → 需要懒加载', () => {
    expect(shouldAutoLoad('indices', none)).toBe(true);
    expect(shouldAutoLoad('index', none)).toBe(true);
    expect(shouldAutoLoad('documents', none)).toBe(true);
    expect(shouldAutoLoad('nodes', none)).toBe(true);
  });

  it('已有数据 → 不重拉（保留搜索词/翻页/输入现场）', () => {
    expect(shouldAutoLoad('indices', all)).toBe(false);
    expect(shouldAutoLoad('index', all)).toBe(false);
    expect(shouldAutoLoad('documents', all)).toBe(false);
    expect(shouldAutoLoad('nodes', all)).toBe(false);
  });

  it('cluster/rest/dsl/log 不依赖缓存数据', () => {
    for (const t of ['cluster', 'rest', 'dsl', 'log'] as const) {
      expect(shouldAutoLoad(t, none), t).toBe(false);
      expect(shouldAutoLoad(t, all), t).toBe(false);
    }
  });
});

describe('docSavePath（N2 乐观并发）', () => {
  it('有版本号 → 拼 if_seq_no/if_primary_term（路径编码）', () => {
    expect(docSavePath('my index', 'doc/1', 7, 2)).toBe('/my%20index/_doc/doc%2F1?if_seq_no=7&if_primary_term=2');
  });

  it('缺版本号 → 整文档 PUT（无 query）', () => {
    expect(docSavePath('i', '1', null, null)).toBe('/i/_doc/1');
    expect(docSavePath('i', '1', 7, null)).toBe('/i/_doc/1');
  });
});

describe('esErrorReason（N3 op 失败原因）', () => {
  it('error.reason / error 字符串；异常形状 null', () => {
    expect(esErrorReason({ error: { type: 'x', reason: 'boom' } })).toBe('boom');
    expect(esErrorReason({ error: 'plain failure' })).toBe('plain failure');
    expect(esErrorReason(null)).toBeNull();
    expect(esErrorReason({ error: { type: 'x' } })).toBeNull();
    expect(esErrorReason('str')).toBeNull();
  });
});
