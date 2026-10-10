import { describe, expect, it } from 'vitest';
import { isDangerousRequest } from '../../src/elasticsearch/esDangerous';

describe('isDangerousRequest（P8 危险操作判定）', () => {
  it('清库级删除：DELETE /、/*、_all', () => {
    expect(isDangerousRequest('DELETE', '/').reason).toBe('delete-all');
    expect(isDangerousRequest('DELETE', '/*').reason).toBe('delete-all');
    expect(isDangerousRequest('DELETE', '/_all').reason).toBe('delete-all');
  });

  it('DELETE <index>：危险且要求输入索引名；通配/多索引不要求', () => {
    const r = isDangerousRequest('DELETE', '/my-index');
    expect(r.dangerous).toBe(true);
    expect(r.reason).toBe('delete-index');
    expect(r.typedIndexName).toBe('my-index');

    expect(isDangerousRequest('DELETE', '/idx*').typedIndexName).toBeUndefined();
    expect(isDangerousRequest('DELETE', '/idx1,idx2').typedIndexName).toBeUndefined();
  });

  it('DELETE 文档不是索引级危险操作', () => {
    expect(isDangerousRequest('DELETE', '/my-index/_doc/1').dangerous).toBe(false);
    expect(isDangerousRequest('DELETE', '/_index_template/foo').dangerous).toBe(false); // 归 security-snapshot-template 之外（_index_template 不在清单）
  });

  it('PUT/POST _cluster/settings 危险', () => {
    expect(isDangerousRequest('PUT', '/_cluster/settings', { persistent: {} }).reason).toBe('cluster-settings');
    expect(isDangerousRequest('POST', '_cluster/settings').reason).toBe('cluster-settings');
    expect(isDangerousRequest('GET', '/_cluster/settings').dangerous).toBe(false);
  });

  it('_delete_by_query：match_all 或未带 query 危险；带条件不危险', () => {
    expect(isDangerousRequest('POST', '/idx/_delete_by_query', { query: { match_all: {} } }).reason).toBe('delete-by-query-match-all');
    expect(isDangerousRequest('POST', '/idx/_delete_by_query').reason).toBe('delete-by-query-match-all');
    expect(isDangerousRequest('POST', '/idx/_delete_by_query', { query: { term: { a: 1 } } }).dangerous).toBe(false);
  });

  it('非读方法触碰 _security/_snapshot/_template 危险；GET 放行', () => {
    expect(isDangerousRequest('PUT', '/_security/user/foo', {}).reason).toBe('security-snapshot-template');
    expect(isDangerousRequest('DELETE', '/_snapshot/repo/snap').reason).toBe('security-snapshot-template');
    expect(isDangerousRequest('PUT', '/_template/legacy').reason).toBe('security-snapshot-template');
    expect(isDangerousRequest('GET', '/_security/_authenticate').dangerous).toBe(false);
  });

  it('普通读写不危险', () => {
    expect(isDangerousRequest('POST', '/idx/_search', { query: { match_all: {} } }).dangerous).toBe(false);
    expect(isDangerousRequest('PUT', '/idx/_doc/1', { a: 1 }).dangerous).toBe(false);
    expect(isDangerousRequest('GET', '/_cat/indices').dangerous).toBe(false);
  });
});