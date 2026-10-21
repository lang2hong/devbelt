import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ audits: [] as any[] }));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { title: '' };
    post = vi.fn();
    initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    dispose(): void { this.onDispose(); }
    reveal(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/utils/auditLogger', () => ({
  AuditLogger: { tryLog: (entry: any) => { h.audits.push(entry); } },
}));

import { ElasticsearchView, splitEsPathQuery } from '../../src/result/elasticsearchView';
import { EsDslStore } from '../../src/result/esDslStore';
import { recordEsRequest } from '../../src/result/esRequestLogStore';

const conn: any = {
  id: 'es1', name: 'es', dbType: 'ELASTICSEARCH', host: 'localhost', port: 9200,
  esProtocol: 'http', esPathPrefix: '/es', readOnly: false,
};

beforeEach(() => { ElasticsearchView.closeAll(); h.audits.length = 0; });

function ok(status: number, body: unknown, tookMs = 1) {
  return { status, headers: { 'content-type': 'application/json' }, body, tookMs };
}

function makeView(opts: { readOnly?: boolean; handler?: (method: string, path: string, body: unknown, o: any) => any } = {}) {
  const requests: { method: string; path: string; body: unknown; query: unknown; opts: any }[] = [];
  const es = {
    ping: async () => ok(200, { version: { number: '8.13.0' }, cluster_name: 'c1' }),
    clusterInfo: async () => ok(200, { version: { number: '8.13.0' }, cluster_name: 'c1' }),
    clusterHealth: async () => ok(200, { status: 'green', number_of_nodes: 3 }),
    request: vi.fn(async (method: string, path: string, body: unknown, q: unknown, o: any) => {
      requests.push({ method, path, body, query: q, opts: o });
      return opts.handler ? opts.handler(method, path, body, o) : ok(200, { acknowledged: true });
    }),
    bulkDelete: vi.fn(async (_index: string, ids: string[]) => ok(200, {
      errors: false,
      items: ids.map((id) => ({ delete: { _id: id, status: 200 } })),
    })),
    close: vi.fn(),
    isAlive: () => true,
  };
  const manager: any = {
    retain: vi.fn(),
    release: vi.fn(),
    connect: async () => ({
      kind: 'elasticsearch',
      capabilities: { readOnly: !!opts.readOnly },
      es, connId: conn.id, isAlive: () => true, close: vi.fn(),
    }),
  };
  const view: any = ElasticsearchView.open({ ...conn, readOnly: !!opts.readOnly }, manager, 'rest');
  view.__reqs = requests;
  return { view, requests, manager, es };
}

function posts(view: any): any[] {
  return (view.post as any).mock.calls.map((c: any[]) => c[0]);
}

async function mount(view: any): Promise<void> {
  await view.handleMessage({ type: 'ready' });
  await view.handleMessage({ type: 'ready' });
  (view.post as any).mockClear();
  h.audits.length = 0;
  // 首屏 pushCluster 会额外拉一次 _cat/indices；清理计数/捕获，避免污染断言。
  (view.__reqs as unknown[] | undefined)?.splice(0);
}

describe('ElasticsearchView（P8 S2）', () => {
  it('两次 ready 协议：首个 ready 发 init（mode=elasticsearch），第二个拉 config + cluster', async () => {
    const { view } = makeView();
    await view.handleMessage({ type: 'ready' });
    expect(posts(view)[0]).toMatchObject({ type: 'init', mode: 'elasticsearch' });
    await view.handleMessage({ type: 'ready' });
    const sent = posts(view);
    expect(sent.find((m) => m.type === 'esConfig')).toMatchObject({ protocol: 'http', pathPrefix: '/es', readOnly: false, tab: 'rest' });
    expect(sent.find((m) => m.type === 'esCluster')?.snapshot).toMatchObject({ version: '8.13.0', clusterName: 'c1' });
  });

  it('injectDsl：未就绪缓存、两次 ready 后补发 esInjectDsl；已就绪立即发', async () => {
    const { view } = makeView();
    view.injectDsl('orders', '{"query":{"match_all":{}}}');
    expect(posts(view)).toEqual([]);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    const inject = posts(view).find((m: any) => m.type === 'esInjectDsl');
    expect(inject).toEqual({ type: 'esInjectDsl', index: 'orders', body: '{"query":{"match_all":{}}}' });

    await mount(view);
    view.injectDsl('logs-2026', '{"size":1}');
    expect((view as any).tab).toBe('dsl');
    expect(posts(view)).toEqual([{ type: 'esInjectDsl', index: 'logs-2026', body: '{"size":1}' }]);
  });

  it('GET 成功：直接回 esRestResult，不落审计', async () => {
    const { view, requests } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '/_cat/indices', body: null });
    expect(requests).toHaveLength(1);
    expect(posts(view)[0]).toMatchObject({ type: 'esRestResult', id: 'r1', status: 200 });
    expect(h.audits).toHaveLength(0);
  });

  it('危险请求（DELETE /index）先确认，未确认不发请求；typed 名称匹配后执行并审计', async () => {
    const { view, requests } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'DELETE', path: '/old-index', body: null });
    expect(requests).toHaveLength(0);
    const confirmMsg = posts(view)[0];
    expect(confirmMsg).toMatchObject({ type: 'esConfirmRequired', kind: 'dangerous', typedIndexName: 'old-index' });
    // 输入不匹配 → 拒绝执行。
    await view.handleMessage({ type: 'esConfirm', id: 'r1', accept: true, typedName: 'wrong' });
    expect(requests).toHaveLength(0);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esRestResult', status: 0 });
    // 重新发起 + 精确匹配 → 执行并审计。
    await view.handleMessage({ type: 'esRest', id: 'r2', method: 'DELETE', path: '/old-index', body: null });
    await view.handleMessage({ type: 'esConfirm', id: 'r2', accept: true, typedName: 'old-index' });
    expect(requests).toHaveLength(1);
    expect(requests[0].opts.force).toBeFalsy();
    expect(posts(view).at(-1)).toMatchObject({ type: 'esRestResult', id: 'r2', status: 200 });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: 'es_rest', sql: 'DELETE /old-index' });
  });

  it('DELETE / 之类无 typed 要求的危险操作，确认即执行', async () => {
    const { view, requests } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'DELETE', path: '/tmp*', body: null });
    expect(posts(view)[0].typedIndexName).toBeNull();
    await view.handleMessage({ type: 'esConfirm', id: 'r1', accept: true });
    expect(requests).toHaveLength(1);
  });

  it('用户取消确认 → cancelled 结果，不发请求', async () => {
    const { view, requests } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'DELETE', path: '/idx', body: null });
    await view.handleMessage({ type: 'esConfirm', id: 'r1', accept: false });
    expect(requests).toHaveLength(0);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esRestResult', id: 'r1', status: 0 });
  });

  it('只读连接 403 → 转单条解锁确认；接受后带 force 重发', async () => {
    const { view, requests, es } = makeView({ readOnly: true });
    es.request.mockImplementation(async (method: string, path: string, body: unknown, q: unknown, o: any) => {
      requests.push({ method, path, body, query: q, opts: o });
      if (!o?.force) return ok(403, { error: { type: 'forbidden', reason: 'read-only mode' } });
      return ok(200, { acknowledged: true });
    });
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'POST', path: '/idx/_doc', body: '{"a":1}' });
    expect(posts(view)[0]).toMatchObject({ type: 'esConfirmRequired', kind: 'readonly' });
    await view.handleMessage({ type: 'esConfirm', id: 'r1', accept: true });
    expect(requests).toHaveLength(2);
    expect(requests[1].opts.force).toBe(true);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esRestResult', id: 'r1', status: 200 });
  });

  it('只读连接 403 后取消 → 不重发', async () => {
    const { view, requests, es } = makeView({ readOnly: true });
    es.request.mockImplementation(async (method: string, path: string, body: unknown, q: unknown, o: any) => {
      requests.push({ method, path, body, query: q, opts: o });
      return ok(403, { error: { type: 'forbidden', reason: 'read-only mode' } });
    });
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'POST', path: '/idx/_doc', body: null });
    await view.handleMessage({ type: 'esConfirm', id: 'r1', accept: false });
    expect(requests).toHaveLength(1);
    expect(posts(view).at(-1)).toMatchObject({ id: 'r1', status: 0 });
  });

  it('非法 JSON body → validation 结果，不发请求', async () => {
    const { view, requests } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'POST', path: '/idx/_search', body: '{bad' });
    expect(requests).toHaveLength(0);
    expect(posts(view)[0]).toMatchObject({ type: 'esRestResult', id: 'r1', status: 0 });
    expect(JSON.stringify(posts(view)[0].body)).toContain('validation');
  });

  it('路径为空 → validation 结果', async () => {
    const { view, requests } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '  ', body: null });
    expect(requests).toHaveLength(0);
    expect(posts(view)[0]).toMatchObject({ type: 'esRestResult', id: 'r1', status: 0 });
  });

  it('网络错误 → status 0 network_error 结果', async () => {
    const { view, es } = makeView();
    await mount(view);
    es.request.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '/', body: null });
    expect(posts(view)[0]).toMatchObject({ type: 'esRestResult', id: 'r1', status: 0 });
    expect(JSON.stringify(posts(view)[0].body)).toContain('ECONNREFUSED');
  });

  it('响应超过 1MB → truncated 标记', async () => {
    const { view, es } = makeView();
    const big = 'x'.repeat(1024 * 1024 + 10);
    es.request.mockImplementation(async () => ok(200, { data: big }));
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '/big', body: null });
    expect(posts(view)[0].truncated).toBe(true);
    expect(String(posts(view)[0].body).length).toBe(1024 * 1024);
  });

  it('esRefreshCluster → 重新下发快照', async () => {
    const { view } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRefreshCluster' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esCluster' });
  });

  it('关闭面板：release 连接；再次 open 创建新实例', async () => {
    const { view, manager } = makeView();
    await mount(view);
    view.dispose();
    expect(manager.release).toHaveBeenCalledWith(conn.id);
  });

  it('同连接重复 open：复用实例并切 tab', async () => {
    const { view, manager } = makeView();
    await mount(view);
    const again = ElasticsearchView.open({ ...conn }, manager, 'cluster');
    expect(again).toBe(view);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esTab', tab: 'cluster' });
  });

  it('S3：esLoadIndices → 解析 cat/indices 并按名称排序下发', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async (_m: string, path: string) => {
      expect(path).toBe('/_cat/indices');
      return ok(200, [
        { index: 'zzz', health: 'red', pri: '1', rep: '0' },
        { index: 'aaa', health: 'green', pri: '1', rep: '0' },
      ]);
    });
    await mount(view);
    await view.handleMessage({ type: 'esLoadIndices' });
    const msg = posts(view).find((m) => m.type === 'esIndices');
    expect(msg.items.map((i: any) => i.name)).toEqual(['aaa', 'zzz']);
    expect(msg.items[0]).toMatchObject({ health: 'green', primaryShards: 1 });
  });

  it('S3：cat/indices 失败 → esIndexError(id=indices)', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async () => ok(500, { error: { type: 'x', reason: 'boom' } }));
    await mount(view);
    await view.handleMessage({ type: 'esLoadIndices' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esIndexError', id: 'indices', message: 'boom' });
  });

  it('S3：esLoadIndex → mapping/settings/aliases/stats 并行加载并下发', async () => {
    const { view, es } = makeView();
    const paths: string[] = [];
    await mount(view);
    es.request.mockImplementation(async (_m: string, path: string) => {
      paths.push(path);
      if (path.endsWith('/_mapping')) return ok(200, { a: { mappings: {} } });
      if (path.endsWith('/_settings')) return ok(200, { a: { settings: {} } });
      if (path.endsWith('/_stats')) return ok(200, { _all: { primaries: {} } });
      return ok(200, { a: { aliases: { al: {} } } });
    });
    await view.handleMessage({ type: 'esLoadIndex', id: 'x1', name: 'my index' });
    expect(paths.sort()).toEqual(['/my%20index/_alias', '/my%20index/_mapping', '/my%20index/_settings', '/my%20index/_stats']);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esIndexData', id: 'x1', name: 'my index' });
    expect(posts(view).at(-1).truncated).toEqual({ mapping: false, settings: false, aliases: false, stats: false });
  });

  it('S3：索引详情任一请求失败 → esIndexError', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async (_m: string, path: string) => path.endsWith('/_mapping')
      ? ok(404, { error: { type: 'index_not_found_exception', reason: 'no such index' } })
      : ok(200, {}));
    await mount(view);
    await view.handleMessage({ type: 'esLoadIndex', id: 'x1', name: 'gone' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esIndexError', id: 'x1', name: 'gone', message: 'no such index' });
  });

  it('S3：索引详情大响应 → 各块独立截断标记', async () => {
    const { view, es } = makeView();
    const big = 'x'.repeat(1024 * 1024 + 5);
    es.request.mockImplementation(async (_m: string, path: string) => path.endsWith('/_mapping') ? ok(200, { big }) : ok(200, {}));
    await mount(view);
    await view.handleMessage({ type: 'esLoadIndex', id: 'x1', name: 'a' });
    const msg = posts(view).at(-1);
    expect(msg.truncated).toEqual({ mapping: true, settings: false, aliases: false, stats: false });
    expect(String(msg.mapping).length).toBe(1024 * 1024);
  });

  it('S3：open 带索引名 → esConfig 下发 indexName', async () => {
    const manager: any = {
      retain: vi.fn(), release: vi.fn(),
      connect: async () => ({
        kind: 'elasticsearch', capabilities: { readOnly: false }, connId: conn.id, isAlive: () => true, close: vi.fn(),
        es: {
          ping: async () => ok(200, {}),
          clusterInfo: async () => ok(200, {}),
          clusterHealth: async () => ok(200, {}),
          request: async () => ok(200, []),
        },
      }),
    };
    const view: any = ElasticsearchView.open({ ...conn }, manager, 'index', 'logs-2024');
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(posts(view).find((m) => m.type === 'esConfig')).toMatchObject({ tab: 'index', indexName: 'logs-2024' });
    view.dispose();
  });
});
// ────────────────────────── S4：文档 / DSL / 节点 / 保存查询 / 日志 ──────────────────────────

describe('ElasticsearchView S4', () => {
  it('esLoadDocs：match_all + sort=_doc + search_after 分页与游标', async () => {
    const { view, es } = makeView();
    const bodies: any[] = [];
    await mount(view);
    es.request.mockImplementation(async (_m: string, _p: string, body: any) => {
      bodies.push(body);
      return ok(200, {
        took: 2,
        hits: {
          total: { value: 3 },
          hits: [
            { _index: 'i', _id: '1', _source: { a: 1 }, sort: [10] },
            { _index: 'i', _id: '2', _source: { a: 2 }, sort: [20] },
          ],
        },
      });
    });
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null });
    const searchBodies = (): any[] => bodies.filter((b) => b && b.sort);
    expect(searchBodies()[0]).toMatchObject({ sort: ['_doc'], size: 50 });
    const msg = posts(view).at(-1);
    expect(msg).toMatchObject({ type: 'esDocs', id: 'd1', index: 'i', total: 3 });
    expect(msg.hits.map((h: any) => h.id)).toEqual(['1', '2']);
    expect(msg.searchAfter).toEqual([20]);
    await view.handleMessage({ type: 'esLoadDocs', id: 'd2', index: 'i', searchAfter: [20] });
    expect(searchBodies()[1].search_after).toEqual([20]);
  });

  it('esLoadDocs：query → query_string；随包下发 mapping 字段建议', async () => {
    const { view, es } = makeView();
    await mount(view);
    const seen: { path: string; body: any }[] = [];
    es.request.mockImplementation(async (_m: string, path: string, body: any) => {
      seen.push({ path, body });
      if (path.endsWith('/_mapping')) {
        return ok(200, { i: { mappings: { properties: { name: { type: 'keyword' }, age: { type: 'integer' } } } } });
      }
      return ok(200, { hits: { total: 1, hits: [{ _id: '1', _source: { name: 'a' } }] } });
    });
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null, query: 'name:foo AND age:[1 TO 9]' });
    const search = seen.find((c) => c.path.endsWith('/_search'))!;
    expect(search.body.query).toEqual({ query_string: { query: 'name:foo AND age:[1 TO 9]', default_operator: 'OR' } });
    const msg = posts(view).at(-1);
    expect(msg.fields).toEqual([{ path: 'name', type: 'keyword' }, { path: 'age', type: 'integer' }]);
    // 字段缓存：第二页不再请求 mapping。
    await view.handleMessage({ type: 'esLoadDocs', id: 'd2', index: 'i', searchAfter: [1] });
    expect(seen.filter((c) => c.path.endsWith('/_mapping'))).toHaveLength(1);
  });

  it('esLoadDocs：空 query → match_all；mapping 失败 → fields=[] 不阻塞', async () => {
    const { view, es } = makeView();
    await mount(view);
    const seen: { path: string; body: any }[] = [];
    es.request.mockImplementation(async (_m: string, path: string, body: any) => {
      seen.push({ path, body });
      if (path.endsWith('/_mapping')) return ok(500, { error: { type: 'x', reason: 'boom' } });
      return ok(200, { hits: { total: 0, hits: [] } });
    });
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null, query: '   ' });
    const search = seen.find((c) => c.path.endsWith('/_search'))!;
    expect(search.body.query).toEqual({ match_all: {} });
    const msg = posts(view).at(-1);
    expect(msg).toMatchObject({ type: 'esDocs', id: 'd1' });
    expect(msg.fields).toEqual([]);
  });

  it('esLoadDocs：文本模式 AND → default_operator=AND', async () => {
    const { view, es } = makeView();
    await mount(view);
    const seen: any[] = [];
    es.request.mockImplementation(async (_m: string, path: string, body: any) => {
      if (!path.endsWith('/_search')) return ok(200, {});
      seen.push(body);
      return ok(200, { hits: { total: 0, hits: [] } });
    });
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null, query: 'alice bob', queryMode: 'text', defaultOperator: 'AND' });
    expect(seen[0].query).toEqual({ query_string: { query: 'alice bob', default_operator: 'AND' } });
  });

  it('esLoadDocs：DSL 模式 → 完整 body（补 sort/size，保留 search_after）', async () => {
    const { view, es } = makeView();
    await mount(view);
    const seen: any[] = [];
    es.request.mockImplementation(async (_m: string, path: string, body: any) => {
      if (!path.endsWith('/_search')) return ok(200, {});
      seen.push(body);
      return ok(200, { hits: { total: 0, hits: [] } });
    });
    await view.handleMessage({
      type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: [7],
      query: '{"query":{"bool":{"must":[{"term":{"age":20}}]}},"size":5}', queryMode: 'dsl',
    });
    expect(seen[0]).toMatchObject({
      query: { bool: { must: [{ term: { age: 20 } }] } },
      size: 5,
      sort: ['_doc'],
      search_after: [7],
    });
  });

  it('esLoadDocs：DSL 模式非法 JSON → validation 错误，不发请求', async () => {
    const { view, es } = makeView();
    await mount(view);
    es.request.mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith('/_search')) throw new Error('should not reach');
      return ok(200, {});
    });
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null, query: '{bad', queryMode: 'dsl' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDocsError', id: 'd1', error: { type: 'validation' } });
  });

  it('esLoadDocs：单文档超大 source → 截断为字符串', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async () => ok(200, {
      hits: { total: 1, hits: [{ _id: 'big', _source: { x: 'a'.repeat(1024 * 1024 + 9) } }] },
    }));
    await mount(view);
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null });
    const msg = posts(view).at(-1);
    expect(msg.truncated).toBe(true);
    expect(typeof msg.hits[0].source).toBe('string');
  });

  it('esLoadDocs 失败 → esDocsError（结构化 reason）', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async () => ok(404, { error: { type: 'index_not_found_exception', reason: 'no such index [x]' } }));
    await mount(view);
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'x', searchAfter: null });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDocsError', index: 'x', error: { type: 'index_not_found_exception', message: 'no such index [x]' } });
  });

  it('esGetDoc：命中 → source + N2 版本号；404 → found=false', async () => {
    const { view, es } = makeView();
    let reply: any = ok(200, { _id: '1', _source: { a: 1 }, _seq_no: 3, _primary_term: 1 });
    es.request.mockImplementation(async () => reply);
    await mount(view);
    await view.handleMessage({ type: 'esGetDoc', id: 'g1', index: 'i', docId: '1' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDoc', id: 'g1', docId: '1', found: true, source: { a: 1 }, seqNo: 3, primaryTerm: 1 });
    reply = ok(404, { error: { type: 'not_found', reason: 'x' } });
    await view.handleMessage({ type: 'esGetDoc', id: 'g2', index: 'i', docId: 'gone' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDoc', id: 'g2', found: false, source: null });
  });

  it('esRunDsl：成功 → 指标/hits/aggregations/raw', async () => {
    const { view, es } = makeView();
    await mount(view);
    es.request.mockImplementation(async (_m: string, _p: string, body: any) => {
      expect(body).toMatchObject({ query: { match_all: {} } });
      return ok(200, {
        took: 3, timed_out: false,
        hits: { total: { value: 1 }, hits: [{ _id: '1', _source: { a: 1 } }] },
        aggregations: { by_type: { buckets: [] } },
      });
    });
    await view.handleMessage({ type: 'esRunDsl', id: 'x1', index: 'i', body: '{ "query": { "match_all": {} } }' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDslResult', id: 'x1', took: 3, timedOut: false, total: 1 });
    expect(posts(view).at(-1).aggregations).toEqual({ by_type: { buckets: [] } });
  });

  it('esRunDsl：未给 sort 时保留相关性排序并返回 searchAfter 游标', async () => {
    const { view, es } = makeView();
    await mount(view);
    let seen: any;
    es.request.mockImplementation(async (_m: string, _p: string, body: any) => {
      seen = body;
      return ok(200, { hits: { total: { value: 2 }, hits: [{ _id: '1', _source: { a: 1 }, sort: ['doc-1'] }] } });
    });
    await view.handleMessage({ type: 'esRunDsl', id: 'x1', index: 'i', body: '{"query":{"match_all":{}}}' });
    expect(seen.sort).toEqual(['_score', '_doc']);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDslResult', id: 'x1', searchAfter: ['doc-1'] });

    es.request.mockImplementation(async () => ok(200, { hits: { total: { value: 0 }, hits: [] } }));
    await view.handleMessage({ type: 'esRunDsl', id: 'x2', index: 'i', body: '{"query":{"match_all":{}}}' });
    expect(posts(view).at(-1).searchAfter).toBeNull();
  });

  it('esRunDsl：续页覆盖 search_after、移除 from 并保留自定义 sort', async () => {
    const { view, es } = makeView();
    await mount(view);
    let seen: any;
    es.request.mockImplementation(async (_m: string, _p: string, body: any) => {
      seen = body;
      return ok(200, { hits: { total: { value: 5 }, hits: [{ _id: '2', sort: [2] }] } });
    });
    await view.handleMessage({
      type: 'esRunDsl', id: 'x2', index: 'i',
      body: '{"query":{"match_all":{}},"from":10,"search_after":[0],"sort":["created_at"]}',
      searchAfter: [1],
    });
    expect(seen.sort).toEqual(['created_at']);
    expect(seen.search_after).toEqual([1]);
    expect(seen.from).toBeUndefined();
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDslResult', id: 'x2', searchAfter: [2] });
  });

  it('esRunDsl：非法 JSON / 非对象 → validation', async () => {
    const { view } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRunDsl', id: 'x1', index: 'i', body: '{bad' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDslError', error: { type: 'validation' } });
    await view.handleMessage({ type: 'esRunDsl', id: 'x2', index: 'i', body: '[1,2]' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esDslError', id: 'x2', error: { type: 'validation' } });
  });

  it('esRunDsl：ES 结构化错误 → esDslError 带 type/rootCause', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async () => ok(400, {
      error: { type: 'parsing_exception', reason: 'bad query', root_cause: [{ type: 'parsing_exception', reason: 'unknown field [zzz]' }] },
    }));
    await mount(view);
    await view.handleMessage({ type: 'esRunDsl', id: 'x1', index: 'i', body: '{"query":{}}' });
    const msg = posts(view).at(-1);
    expect(msg).toMatchObject({ type: 'esDslError', error: { type: 'parsing_exception', message: 'bad query' } });
    expect(msg.error.rootCause).toEqual(['unknown field [zzz]']);
  });

  it('esBulkDelete：去重后执行 _bulk，按 item 状态统计并审计', async () => {
    const { view, es } = makeView();
    await mount(view);
    es.bulkDelete.mockResolvedValue(ok(200, {
      errors: true,
      items: [{ delete: { _id: '1', status: 200 } }, { delete: { _id: '2', status: 404 } }],
    }));
    await view.handleMessage({ type: 'esBulkDelete', id: 'b1', index: 'i', ids: ['1', '1', '2', ''] });
    expect(es.bulkDelete).toHaveBeenCalledWith('i', ['1', '2']);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esBulkDeleteResult', id: 'b1', index: 'i', status: 200, deleted: 1, failed: 1 });
    expect(h.audits.at(-1)?.sql).toBe('POST /i/_bulk (2 docs)');
  });

  it('esBulkDelete：只读连接拒绝且不发请求', async () => {
    const { view, es } = makeView({ readOnly: true });
    await mount(view);
    await view.handleMessage({ type: 'esBulkDelete', id: 'b1', index: 'i', ids: ['1'] });
    expect(es.bulkDelete).not.toHaveBeenCalled();
    expect(posts(view).at(-1)).toMatchObject({ type: 'esBulkDeleteResult', status: 0, deleted: 0, failed: 1 });
  });

  it('esBulkDelete：空 ID 列表返回校验错误且不发请求', async () => {
    const { view, es } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esBulkDelete', id: 'b1', index: 'i', ids: ['', ''] });
    expect(es.bulkDelete).not.toHaveBeenCalled();
    expect(posts(view).at(-1)).toMatchObject({ type: 'esBulkDeleteResult', status: 0, deleted: 0, failed: 0 });
  });

  it('esLoadNodes：解析 cat/nodes 并下发', async () => {
    const { view, es } = makeView();
    await mount(view);
    es.request.mockImplementation(async (_m: string, path: string) => {
      expect(path).toBe('/_cat/nodes');
      return ok(200, [{ name: 'n1', ip: '10.0.0.1', 'heap.percent': '10', cpu: '1', 'node.role': 'd', master: '*' }]);
    });
    await view.handleMessage({ type: 'esLoadNodes' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esNodes' });
    expect(posts(view).at(-1).items[0]).toMatchObject({ name: 'n1', heapPercent: 10, master: '*' });
  });

  it('esLoadNodes 失败 → esNodesError', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async () => ok(500, { error: { type: 'x', reason: 'boom' } }));
    await mount(view);
    await view.handleMessage({ type: 'esLoadNodes' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esNodesError', error: { message: 'boom' } });
  });

  it('保存查询：save → list → delete（Memento store）', async () => {
    let saved: any[] = [];
    const memento: any = { get: () => saved, update: (_k: string, v: any) => { saved = v; return Promise.resolve(); } };
    ElasticsearchView.configureDslStore(new EsDslStore(memento));
    const { view } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esLoadSavedDsl' });
    expect(posts(view).at(-1)).toEqual({ type: 'esSavedDsl', items: [] });
    await view.handleMessage({ type: 'esSaveDsl', name: 'all', index: 'i', body: '{}' });
    const listed = posts(view).at(-1);
    expect(listed.type).toBe('esSavedDsl');
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ name: 'all', index: 'i' });
    const id = listed.items[0].id;
    await view.handleMessage({ type: 'esDeleteDsl', id });
    expect(posts(view).at(-1)).toEqual({ type: 'esSavedDsl', items: [] });
  });

  it('esLoadLog：返回命令日志快照', async () => {
    const { view } = makeView();
    recordEsRequest(conn.id, { method: 'GET', path: '/', status: 200, tookMs: 3, time: Date.now() });
    await mount(view);
    await view.handleMessage({ type: 'esLoadLog' });
    const msg = posts(view).at(-1);
    expect(msg.type).toBe('esLog');
    expect(msg.items.some((e: any) => e.method === 'GET' && e.path === '/')).toBe(true);
  });

  it('esConfig：下发连接颜色', async () => {
    const manager: any = {
      retain: vi.fn(), release: vi.fn(),
      connect: async () => ({
        kind: 'elasticsearch', capabilities: { readOnly: false }, connId: conn.id, isAlive: () => true, close: vi.fn(),
        es: { ping: async () => ok(200, {}), clusterInfo: async () => ok(200, {}), clusterHealth: async () => ok(200, {}), request: async () => ok(200, []) },
      }),
    };
    const view: any = ElasticsearchView.open({ ...conn, color: '#ff0000' }, manager, 'cluster');
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(posts(view).find((m) => m.type === 'esConfig')).toMatchObject({ color: '#ff0000' });
    view.dispose();
  });
});

describe('Round 2 修复（N1/N2/N4）', () => {
  it('N4：写请求成功后字段建议缓存失效，下一步重新拉 mapping', async () => {
    const { view, es } = makeView();
    await mount(view);
    const mappingCalls: string[] = [];
    es.request.mockImplementation(async (m: string, path: string) => {
      if (m === 'GET' && path.endsWith('/_mapping')) mappingCalls.push(path);
      return ok(200, {});
    });
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null });
    expect(mappingCalls).toHaveLength(1);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'PUT', path: '/i/_mapping', body: '{}' });
    await view.handleMessage({ type: 'esLoadDocs', id: 'd2', index: 'i', searchAfter: null });
    expect(mappingCalls).toHaveLength(2);
  });

  it('N2：搜索命中下发 seqNo/primaryTerm', async () => {
    const { view, es } = makeView();
    await mount(view);
    es.request.mockImplementation(async (_m: string, path: string) =>
      path.endsWith('/_mapping') ? ok(200, {}) : ok(200, { hits: { total: 1, hits: [{ _id: '1', _source: {}, _seq_no: 9, _primary_term: 4 }] } }));
    await view.handleMessage({ type: 'esLoadDocs', id: 'd1', index: 'i', searchAfter: null });
    expect(posts(view).at(-1).hits[0]).toMatchObject({ id: '1', seqNo: 9, primaryTerm: 4 });
  });
});

describe('P8 收尾：集群索引数', () => {
  it('esRefreshCluster 快照带 indicesCount', async () => {
    const { view, es } = makeView();
    es.request.mockImplementation(async (_m: string, path: string) =>
      path === '/_cat/indices' ? ok(200, [{ index: 'a' }, { index: 'b' }]) : ok(200, {}));
    await mount(view);
    await view.handleMessage({ type: 'esRefreshCluster' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esCluster' });
    expect(posts(view).at(-1).snapshot.indicesCount).toBe(2);
  });
});

// ────────────────────────── 评审修复（C1/H1/H2） ──────────────────────────

describe('评审修复 C1/H1/H2', () => {
  it('H1：REST 控制台 query string 透传（?v&pretty），# 片段丢弃', async () => {
    const { view, requests } = makeView();
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '/_cat/indices?v&pretty#frag', body: null });
    const req = requests.find((r) => r.path === '/_cat/indices')!;
    expect(req.query).toEqual({ v: '', pretty: '' });
    expect(posts(view).at(-1)).toMatchObject({ type: 'esRestResult', id: 'r1', status: 200 });
  });

  it('splitEsPathQuery：无 query 原样；空 path + query 视为空路径', () => {
    expect(splitEsPathQuery('/idx/_search')).toEqual({ path: '/idx/_search', query: undefined });
    expect(splitEsPathQuery('/_cat/indices?h=index,health')).toEqual({ path: '/_cat/indices', query: { h: 'index,health' } });
    expect(splitEsPathQuery('?v')).toEqual({ path: '', query: { v: '' } });
  });

  it('H2：真实 ES 权限 403（security_exception）不弹解锁，直接出结果', async () => {
    const { view, es } = makeView({ readOnly: true });
    es.request.mockImplementation(async () => ok(403, { error: { type: 'security_exception', reason: 'unauthorized for action' } }));
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'POST', path: '/idx/_doc', body: null });
    expect(posts(view).some((m) => m.type === 'esConfirmRequired')).toBe(false);
    expect(posts(view).at(-1)).toMatchObject({ type: 'esRestResult', id: 'r1', status: 403 });
  });

  it('H2：切面哨兵 403 仍触发单条解锁（回归）', async () => {
    const { view, es } = makeView({ readOnly: true });
    es.request.mockImplementation(async (_m: string, _p: string, _b: unknown, _q: unknown, o: any) =>
      o?.force ? ok(200, { acknowledged: true }) : ok(403, { error: { type: 'forbidden', reason: 'read-only mode' } }));
    await mount(view);
    await view.handleMessage({ type: 'esRest', id: 'r1', method: 'DELETE', path: '/idx', body: null });
    await view.handleMessage({ type: 'esConfirm', id: 'r1', accept: true, typedName: 'idx' });
    // DELETE /idx 先走危险确认（typed）→ 再哨兵解锁？此处直接给 confirmedDanger 简化路径：
    // 上面第一次是 dangerous 确认；重发后命中 force=false 的哨兵 → 第二次应弹 readonly。
    const confirms = posts(view).filter((m) => m.type === 'esConfirmRequired');
    expect(confirms.map((m) => m.kind)).toEqual(['dangerous', 'readonly']);
  });
});

// ────────────────────────── 复核修复 N1（inflight 并发/dispose） ──────────────────────────

describe('复核修复 N1（inflight）', () => {
  it('N1：并发 REST 请求互不取消（每请求独立 AbortController）', async () => {
    const { view, es } = makeView();
    await mount(view);
    const signals: (AbortSignal | undefined)[] = [];
    const started = [false, false];
    let allStarted!: () => void;
    const bothStarted = new Promise<void>((r) => { allStarted = r; });
    const gates = [0, 1].map(() => {
      let release!: () => void;
      const promise = new Promise<void>((r) => { release = r; });
      return { promise, release };
    });
    es.request.mockImplementation(async (_m: string, _p: string, _b: unknown, _q: unknown, o: any) => {
      const idx = signals.length;
      signals.push(o?.signal);
      started[idx] = true;
      if (started[0] && started[1]) allStarted();
      await gates[idx].promise;
      return ok(200, { idx });
    });
    const p1 = view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '/a', body: null });
    const p2 = view.handleMessage({ type: 'esRest', id: 'r2', method: 'GET', path: '/b', body: null });
    await bothStarted;
    // 旧实现：第二个请求会 abort 第一个（共享 inflight）；现在两者独立。
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
    gates[0].release();
    gates[1].release();
    await Promise.all([p1, p2]);
    const ids = posts(view).filter((m) => m.type === 'esRestResult').map((m) => m.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });

  it('esCancelRest：只中止指定请求并回写 cancelled', async () => {
    const { view, es } = makeView();
    await mount(view);
    const signals: AbortSignal[] = [];
    let startedCount = 0;
    let bothStarted!: () => void;
    const startedP = new Promise<void>((r) => { bothStarted = r; });
    es.request.mockImplementation((_m: string, _p: string, _b: unknown, _q: unknown, o: any) => {
      const idx = signals.length;
      signals.push(o.signal);
      startedCount += 1;
      if (startedCount === 2) bothStarted();
      if (idx === 0) {
        return new Promise((_resolve, reject) => {
          o.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve(ok(200, { idx }));
    });
    const p1 = view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '/slow', body: null });
    const p2 = view.handleMessage({ type: 'esRest', id: 'r2', method: 'GET', path: '/fast', body: null });
    await startedP;
    await view.handleMessage({ type: 'esCancelRest', id: 'r1' });
    await Promise.all([p1, p2]);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    const results = posts(view).filter((m) => m.type === 'esRestResult');
    expect(results.find((m) => m.id === 'r1')).toMatchObject({ status: 0, body: { error: { type: 'cancelled' } } });
    expect(results.find((m) => m.id === 'r2')).toMatchObject({ status: 200 });
  });

  it('N1：dispose 统一 abort 全部在途请求，且不再回写结果', async () => {
    const { view, es } = makeView();
    await mount(view);
    const signals: AbortSignal[] = [];
    let startedResolve!: () => void;
    const startedP = new Promise<void>((r) => { startedResolve = r; });
    let started = false;
    es.request.mockImplementation((_m: string, _p: string, _b: unknown, _q: unknown, o: any) =>
      new Promise((_resolve, reject) => {
        signals.push(o?.signal);
        if (!started) { started = true; startedResolve(); }
        o?.signal?.addEventListener('abort', () => reject(new Error('ES request aborted')));
      }));
    const pending = view.handleMessage({ type: 'esRest', id: 'r1', method: 'GET', path: '/slow', body: null });
    await startedP;
    view.dispose();
    expect(signals[0].aborted).toBe(true);
    await pending;
    expect(posts(view).filter((m) => m.type === 'esRestResult')).toHaveLength(0);
  });
});
