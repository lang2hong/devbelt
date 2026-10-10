import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EsClient, esAuthHeader, isReadEsRequest, loadEsTlsOptions, type EsRequestLog } from '../../src/elasticsearch/esClient';

/** 进程内 HTTP 服务器（真实往返；零外部依赖）。 */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ host: string; port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    host: '127.0.0.1',
    port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function makeClient(target: { host: string; port: number }, opts: Partial<ConstructorParameters<typeof EsClient>[0]> = {}): EsClient {
  return new EsClient({ protocol: 'http', host: target.host, port: target.port, timeoutMs: 2000, ...opts });
}

describe('EsClient：请求封装', () => {
  it('ping/clusterInfo 走 GET /；pathPrefix 与 query 编码正确', async () => {
    const s = await startServer((_req, res) => json(res, 200, { version: { number: '8.15.0' }, cluster_name: 'dev' }));
    servers.push(s);
    const client = makeClient(s, { pathPrefix: '/es/' });
    const res = await client.ping();
    expect(res.status).toBe(200);
    expect((res.body as any).version.number).toBe('8.15.0');
    expect(s.seen[0].url).toBe('/es/');

    await client.catIndices();
    expect(s.seen[1].url).toContain('/es/_cat/indices?');
    expect(s.seen[1].url).toContain('format=json');
    expect(s.seen[1].url).toContain('h=health');
  });

  it('JSON body 序列化 + content-type；非 JSON 响应按原文返回', async () => {
    const s = await startServer((req, res) => {
      if (req.url === '/idx/_search') return json(res, 200, { hits: { total: { value: 0 } } });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain-ok');
    });
    servers.push(s);
    const client = makeClient(s);
    const res = await client.search('idx', { size: 5, body: { query: { match_all: {} } } });
    expect(s.seen[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(s.seen[0].body)).toEqual({ size: 5, query: { match_all: {} } });
    expect((res.body as any).hits.total.value).toBe(0);

    const plain = await client.request('GET', '/_cat/health');
    expect(plain.body).toBe('plain-ok');
  });

  it('文档 CRUD 路径/方法：GET/PUT/POST/DELETE + id 编码', async () => {
    const s = await startServer((_req, res) => json(res, 200, { ok: true }));
    servers.push(s);
    const client = makeClient(s);
    await client.getDocument('my idx', 'a/b');
    expect(s.seen[0].method).toBe('GET');
    expect(s.seen[0].url).toBe('/my%20idx/_doc/a%2Fb');

    await client.indexDocument('idx', '1', { a: 1 });
    expect(s.seen[1].method).toBe('PUT');
    expect(s.seen[1].url).toBe('/idx/_doc/1');

    await client.indexDocument('idx', undefined, { a: 1 });
    expect(s.seen[2].method).toBe('POST');
    expect(s.seen[2].url).toBe('/idx/_doc');

    await client.deleteDocument('idx', '1');
    expect(s.seen[3].method).toBe('DELETE');
    expect(s.seen[3].url).toBe('/idx/_doc/1');
  });

  it('4xx/5xx 不抛错：返回结构化 body', async () => {
    const s = await startServer((_req, res) => json(res, 404, {
      error: { type: 'index_not_found_exception', reason: 'no such index [nope]', root_cause: [{ type: 'index_not_found_exception', reason: 'no such index [nope]', index: 'nope' }] },
    }));
    servers.push(s);
    const client = makeClient(s);
    const res = await client.getMapping('nope');
    expect(res.status).toBe(404);
    expect((res.body as any).error.type).toBe('index_not_found_exception');
  });
});

describe('EsClient：认证与只读切面', () => {
  it('Basic/ApiKey 头（id:key 自动 Base64；raw key 原样；none 无头）', async () => {
    expect(esAuthHeader({ kind: 'none' })).toBeUndefined();
    expect(esAuthHeader({ kind: 'basic', username: 'u', password: 'p' })).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(esAuthHeader({ kind: 'apiKey', apiKey: 'id:key' })).toBe(`ApiKey ${Buffer.from('id:key').toString('base64')}`);
    expect(esAuthHeader({ kind: 'apiKey', apiKey: 'rawtoken' })).toBe('ApiKey rawtoken');
    // 回归：空/空白用户名不发 Basic（否则 ES 回「unable to authenticate user []」误导性 401）。
    expect(esAuthHeader({ kind: 'basic', username: '' })).toBeUndefined();
    expect(esAuthHeader({ kind: 'basic', username: '   ' })).toBeUndefined();

    const s = await startServer((_req, res) => json(res, 200, {}));
    servers.push(s);
    const client = makeClient(s, { auth: { kind: 'basic', username: 'u', password: 'p' } });
    await client.ping();
    expect(s.seen[0].headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('只读拦截：写被拦（服务器未收到）、读/白名单/force 放行', async () => {
    const s = await startServer((_req, res) => json(res, 200, { ok: true }));
    servers.push(s);
    const client = makeClient(s, { readOnly: true });

    const blocked = await client.indexDocument('idx', '1', { a: 1 });
    expect(blocked.status).toBe(403);
    expect((blocked.body as any).error.type).toBe('forbidden');
    expect(s.seen).toHaveLength(0); // 不发请求

    await client.search('idx', { body: { query: { match_all: {} } } }); // POST <index>/_search：白名单
    await client.clusterHealth(); // GET 放行
    expect(s.seen.map((x) => `${x.method} ${x.url}`)).toEqual(['POST /idx/_search', 'GET /_cluster/health']);

    await client.deleteDocument('idx', '1', { force: true }); // 单条解锁
    expect(s.seen[2].method).toBe('DELETE');
  });

  it('isReadEsRequest：GET/HEAD 恒真；读路径段/前缀白名单', () => {
    expect(isReadEsRequest('GET', '/idx/_doc/1')).toBe(true);
    expect(isReadEsRequest('HEAD', '/')).toBe(true);
    expect(isReadEsRequest('POST', '/idx/_search')).toBe(true);
    expect(isReadEsRequest('POST', '/_msearch')).toBe(true);
    expect(isReadEsRequest('PUT', '/idx/_doc/1')).toBe(false);
    expect(isReadEsRequest('DELETE', '/idx')).toBe(false);
    expect(isReadEsRequest('POST', '/_bulk')).toBe(false);
    // 回归 C1：这三段的非 GET 形态是写端点，只读切面必须拦（防 fail-open）。
    expect(isReadEsRequest('PUT', '/idx/_mapping')).toBe(false);
    expect(isReadEsRequest('POST', '/idx/_mapping')).toBe(false);
    expect(isReadEsRequest('PUT', '/idx/_settings')).toBe(false);
    expect(isReadEsRequest('POST', '/_aliases')).toBe(false);
    expect(isReadEsRequest('GET', '/idx/_mapping')).toBe(true);
    expect(isReadEsRequest('GET', '/_aliases')).toBe(true);
  });

  it('path 拒绝绝对 URL 与换行（防注入到 host 拼接）', async () => {
    const s = await startServer((_req, res) => json(res, 200, {}));
    servers.push(s);
    const client = makeClient(s);
    await expect(client.request('GET', 'http://evil.example/x')).rejects.toThrow(/absolute URL/);
    await expect(client.request('GET', '/x\nHost: evil')).rejects.toThrow(/newlines/);
  });
});

describe('EsClient：日志/超时/abort/关闭', () => {
  it('requestLog 记录每条请求（含只读拦截与网络失败）', async () => {
    const s = await startServer((_req, res) => json(res, 200, {}));
    servers.push(s);
    const logs: EsRequestLog[] = [];
    const client = makeClient(s, { readOnly: true, onLog: (e) => logs.push(e) });
    await client.ping();
    await client.indexDocument('idx', '1', {});
    expect(logs.map((l) => [l.method, l.status])).toEqual([['GET', 200], ['PUT', 403]]);
    expect(logs[0].tookMs).toBeGreaterThanOrEqual(0);

    // 网络失败（端口已关）：拒绝 + status 0 日志。
    await servers.pop()!.close();
    const client2 = makeClient(s);
    const logs2: EsRequestLog[] = [];
    client2.onLog((e) => logs2.push(e));
    await expect(client2.ping()).rejects.toThrow();
    expect(logs2[0].status).toBe(0);
    expect(logs2[0].error).toBeTruthy();
  });

  it('超时拒绝；abort 拒绝；关闭后拒绝', async () => {
    const s = await startServer((_req, res) => setTimeout(() => json(res, 200, {}), 300));
    servers.push(s);

    const slow = makeClient(s, { timeoutMs: 50 });
    await expect(slow.ping()).rejects.toThrow(/timed out/);

    const ctrl = new AbortController();
    const aborted = makeClient(s, { timeoutMs: 2000 });
    const p = aborted.ping({ signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow(/aborted/);

    const closed = makeClient(s);
    closed.close();
    await expect(closed.ping()).rejects.toThrow(/closed/);
  });

  it('已 abort 的 signal 直接拒绝（不发起请求）', async () => {
    const s = await startServer((_req, res) => json(res, 200, {}));
    servers.push(s);
    const client = makeClient(s);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(client.ping({ signal: ctrl.signal })).rejects.toThrow(/aborted/);
    expect(s.seen).toHaveLength(0);
  });
});

describe('EsClient：TLS 选项加载', () => {
  it('读取 CA/cert/key 文件为 Buffer；rejectUnauthorized=false 透传', () => {
    const dir = mkdtempSync(join(tmpdir(), 'es-tls-'));
    const ca = join(dir, 'ca.pem');
    writeFileSync(ca, 'CA');
    const opts = loadEsTlsOptions({ caPath: ca, rejectUnauthorized: false });
    expect(Buffer.isBuffer(opts.ca)).toBe(true);
    expect(String(opts.ca)).toBe('CA');
    expect(opts.rejectUnauthorized).toBe(false);
    expect(opts.keepAlive).toBe(true);
  });

  it('文件缺失时构造期 fail-closed', () => {
    expect(() => loadEsTlsOptions({ caPath: '/definitely/not/here.pem' })).toThrow(/failed to read ES TLS files/);
  });
});