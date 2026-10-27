/**
 * EsClient（P8 S1）：Node 内置 `http`/`https` 实现的 ES REST 客户端。
 *
 * 零第三方依赖（决策 D1）；所有 HTTP I/O 在 extension host 侧执行（决策 D6）。
 *
 * 关键边界：
 *  - `request()` 统一封装：pathPrefix + query 编码、JSON body、超时（默认 30s）、AbortSignal；
 *    4xx/5xx **不抛错**（body 交 UI 结构化展示），网络错误/超时/abort 才拒绝。
 *  - 只读切面：`readOnly=true` 时非 GET/HEAD 且不在读路径白名单的请求直接返回 403 假响应
 *    （不发请求）；host 侧可对单条请求 `force: true` 解锁（先弹确认）。
 *  - `requestLog`：每条请求完成（含失败）回调 method/path/status/tookMs/time/error。
 *  - 凭据只在 Authorization 头；不写日志（日志仅 method/path/status）。
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { URL, URLSearchParams } from 'node:url';

export type EsProtocol = 'http' | 'https';

export type EsAuth =
  | { kind: 'none' }
  | { kind: 'basic'; username: string; password?: string }
  | { kind: 'apiKey'; apiKey?: string };

export interface EsTlsOptions {
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  /** 缺省 true（安全默认）；显式 false = 允许自签名（UI 需红字提示）。 */
  rejectUnauthorized?: boolean;
}

export interface EsClientOptions {
  protocol?: EsProtocol;
  host: string;
  port: number;
  /** 反代路径前缀（如 `/es`）；归一为前后带 `/`。 */
  pathPrefix?: string;
  auth?: EsAuth;
  tls?: EsTlsOptions;
  /** 单请求超时（ms），缺省 30000。 */
  timeoutMs?: number;
  readOnly?: boolean;
  onLog?: (entry: EsRequestLog) => void;
}

export interface EsRequestLog {
  method: string;
  path: string;
  /** 网络失败为 0。 */
  status: number;
  tookMs: number;
  time: number;
  error?: string;
}

export interface EsResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** JSON 已解析；非 JSON/解析失败为原文；空体为 null。 */
  body: unknown;
  tookMs: number;
}

export type EsQuery = Record<string, string | number | boolean | null | undefined>;

export interface EsRequestOptions {
  signal?: AbortSignal;
  /** 只读模式下单条解锁（host 先弹确认）。 */
  force?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 读路径白名单（决策 D8）：readOnly 下 POST 这些路径仍放行（GET/HEAD 恒放行）。
 * 不含 `/_nodes`：该命名空间的非 GET 形态是管理端点（`reload_secure_settings`、
 * `shutdown`），属配置修改类，必须 403 拦截后走 host 单条解锁。
 */
const READ_PATH_PREFIXES = ['/_cat', '/_cluster/health', '/_cluster/stats', '/_resolve/index', '/_resolve/cluster'] as const;
// 注意：_mapping/_settings/_aliases 的非 GET 形态是写端点（PUT/POST），不得列入读白名单；
// 其读形态一律走 GET/HEAD（恒放行）。只读下这些写请求由切面 403 拦截 → host 单条解锁确认。
const READ_PATH_SEGMENTS = ['_search', '_count', '_mget', '_msearch', '_field_caps', '_explain', '_validate'] as const;

/** 归一为以 `/` 开头的路径（去 query）。 */
function normalizePath(path: string): string {
  const raw = String(path ?? '').split('?')[0].trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error('ES path must not be an absolute URL');
  if (/[\r\n]/.test(raw)) throw new Error('ES path must not contain newlines');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * 是否只读请求：GET/HEAD 恒真；其余仅 POST 且命中读路径前缀/段白名单（`<index>/_search` 等）。
 *
 * fail-closed：非 POST 的写方法（PUT/DELETE/PATCH）与不在白名单的 POST（`_bulk`、
 * `/_nodes/reload_secure_settings` 等）一律视为写请求，由切面 403 拦截。
 */
export function isReadEsRequest(method: string, path: string): boolean {
  const m = String(method ?? '').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  if (m !== 'POST') return false;
  const p = normalizePath(path);
  if (READ_PATH_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))) return true;
  const segs = p.split('/').filter(Boolean);
  return segs.some((s) => (READ_PATH_SEGMENTS as readonly string[]).includes(s));
}

/** Basic/ApiKey → Authorization 头。ApiKey 输入含 `:` 视为 `id:key` 组合（Base64），否则视为已编码 token。 */
export function esAuthHeader(auth?: EsAuth): string | undefined {
  if (!auth || auth.kind === 'none') return undefined;
  if (auth.kind === 'basic') {
    // 空用户名视为未配置认证：否则会发出 `Basic base64(":")`，ES 只会回
    // 「unable to authenticate user [] for REST request …」这种误导性 401。
    const username = auth.username?.trim();
    if (!username) return undefined;
    return `Basic ${Buffer.from(`${username}:${auth.password ?? ''}`).toString('base64')}`;
  }
  const raw = auth.apiKey ?? '';
  if (raw === '') return undefined;
  const token = raw.includes(':') ? Buffer.from(raw).toString('base64') : raw;
  return `ApiKey ${token}`;
}

/** TLS 选项：读取 CA/cert/key 文件（构造期 fail-closed）；rejectUnauthorized 缺省 true。 */
export function loadEsTlsOptions(tls?: EsTlsOptions): https.AgentOptions {
  if (!tls) return {};
  const out: https.AgentOptions = {};
  if (tls.rejectUnauthorized === false) out.rejectUnauthorized = false;
  try {
    if (tls.caPath) out.ca = readFileSync(tls.caPath);
    if (tls.clientCertPath) out.cert = readFileSync(tls.clientCertPath);
    if (tls.clientKeyPath) out.key = readFileSync(tls.clientKeyPath);
  } catch (err) {
    throw new Error(`failed to read ES TLS files: ${(err as Error).message}`);
  }
  return { ...out, keepAlive: true };
}

/** 归一 pathPrefix：'' | '/es' → '' | '/es'（无尾斜杠）。 */
function normalizePrefix(prefix?: string): string {
  const raw = String(prefix ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error('ES path prefix must not be an absolute URL');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export class EsClient {
  private readonly protocol: EsProtocol;
  private readonly host: string;
  private readonly port: number;
  private readonly pathPrefix: string;
  private readonly authHeader?: string;
  private readonly timeoutMs: number;
  readonly readOnly: boolean;
  private readonly agent: http.Agent | https.Agent;
  private readonly logListeners = new Set<(entry: EsRequestLog) => void>();
  private closed = false;

  constructor(options: EsClientOptions) {
    this.protocol = options.protocol ?? 'http';
    this.host = options.host;
    this.port = options.port;
    this.pathPrefix = normalizePrefix(options.pathPrefix);
    this.authHeader = esAuthHeader(options.auth);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readOnly = options.readOnly === true;
    this.agent = this.protocol === 'https'
      ? new https.Agent(loadEsTlsOptions(options.tls))
      : new http.Agent({ keepAlive: true });
    if (options.onLog) this.logListeners.add(options.onLog);
  }

  /** 追加请求日志监听（返回解除函数）。 */
  onLog(fn: (entry: EsRequestLog) => void): () => void {
    this.logListeners.add(fn);
    return () => { this.logListeners.delete(fn); };
  }

  isAlive(): boolean {
    return !this.closed;
  }

  /** 关闭客户端：销毁 Agent（面板 dispose 时调用；in-flight 由各自 AbortSignal 处理）。 */
  close(): void {
    this.closed = true;
    this.agent.destroy();
  }

  /**
   * 统一请求入口。
   * 只读拦截：`readOnly && !force && !isReadEsRequest()` → 403 假响应（不发网络请求，仍记日志）。
   */
  async request(method: string, path: string, body?: unknown, query?: EsQuery, opts: EsRequestOptions = {}): Promise<EsResponse> {
    const m = String(method ?? 'GET').toUpperCase();
    const p = normalizePath(path);
    if (this.closed) throw new Error('ES client is closed');
    if (this.readOnly && !opts.force && !isReadEsRequest(m, p)) {
      const res: EsResponse = {
        status: 403,
        headers: {},
        body: { error: { type: 'forbidden', reason: 'read-only mode' } },
        tookMs: 0,
      };
      this.emitLog({ method: m, path: p, status: 403, tookMs: 0, time: Date.now(), error: 'read-only mode' });
      return res;
    }
    const started = Date.now();
    try {
      const res = await this.perform(m, p, body, query, opts.signal);
      this.emitLog({ method: m, path: p, status: res.status, tookMs: res.tookMs, time: started });
      return res;
    } catch (err) {
      this.emitLog({ method: m, path: p, status: 0, tookMs: Date.now() - started, time: started, error: (err as Error).message });
      throw err;
    }
  }

  private perform(method: string, path: string, body: unknown, query: EsQuery | undefined, signal: AbortSignal | undefined): Promise<EsResponse> {
    const started = Date.now();
    return new Promise<EsResponse>((resolve, reject) => {
      // 预先已 abort：直接拒绝（不创建请求，避免 destroy 竞态产生未处理 'error'）。
      if (signal?.aborted) { reject(new Error('ES request aborted')); return; }
      const url = this.buildUrl(path, query);
      const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method,
        agent: this.agent,
        headers: {
          accept: 'application/json',
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(this.authHeader ? { authorization: this.authHeader } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          cleanup();
          const text = Buffer.concat(chunks).toString('utf8');
          const ct = String(res.headers['content-type'] ?? '');
          let parsed: unknown = text === '' ? null : text;
          if (text !== '' && (ct.includes('json') || text.trimStart().startsWith('{'))) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, tookMs: Date.now() - started });
        });
      });
      const timer = setTimeout(() => {
        // 带上方法与地址：区分「连不上」和「请求太重」，也方便对照 curl 结果。
        req.destroy(new Error(`ES request timed out after ${this.timeoutMs}ms (${method} ${url})`));
      }, this.timeoutMs);
      const onAbort = (): void => { req.destroy(new Error('ES request aborted')); };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      req.on('error', (err) => { cleanup(); reject(err); });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private buildUrl(path: string, query?: EsQuery): string {
    let qs = '';
    if (query) {
      const entries: [string, string][] = [];
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) entries.push([k, String(v)]);
      }
      qs = new URLSearchParams(entries).toString();
    }
    return `${this.protocol}://${this.host}:${this.port}${this.pathPrefix}${path}${qs ? `?${qs}` : ''}`;
  }

  private emitLog(entry: EsRequestLog): void {
    for (const fn of this.logListeners) {
      try { fn(entry); } catch { /* 日志旁路，不阻断请求 */ }
    }
  }

  // ────────────────────────── 高层方法（S1 子集） ──────────────────────────

  /** `GET /`：版本/集群名（测试连接即此）。 */
  ping(opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', '/', undefined, undefined, opts);
  }

  clusterInfo(opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', '/', undefined, undefined, opts);
  }

  clusterHealth(opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', '/_cluster/health', undefined, undefined, opts);
  }

  /** 索引列表（`_cat/indices` 固定列集，JSON 输出）。 */
  catIndices(opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', '/_cat/indices', undefined, {
      format: 'json',
      h: 'health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size',
    }, opts);
  }

  getMapping(index: string, opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', `/${encodeURIComponent(index)}/_mapping`, undefined, undefined, opts);
  }

  getSettings(index: string, opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', `/${encodeURIComponent(index)}/_settings`, undefined, undefined, opts);
  }

  getAliases(index: string, opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', `/${encodeURIComponent(index)}/_alias`, undefined, undefined, opts);
  }

  /** `_search`：body 透传；size/searchAfter/sort 便捷字段不覆盖 body 里的同名字段。 */
  search(index: string, opts: { size?: number; searchAfter?: unknown[]; sort?: unknown[]; body?: Record<string, unknown> } = {}, reqOpts?: EsRequestOptions): Promise<EsResponse> {
    const body: Record<string, unknown> = { ...(opts.body ?? {}) };
    if (opts.size !== undefined && body.size === undefined) body.size = opts.size;
    if (opts.searchAfter !== undefined && body.search_after === undefined) body.search_after = opts.searchAfter;
    if (opts.sort !== undefined && body.sort === undefined) body.sort = opts.sort;
    return this.request('POST', `/${encodeURIComponent(index)}/_search`, body, undefined, reqOpts);
  }

  getDocument(index: string, id: string, opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('GET', `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`, undefined, undefined, opts);
  }

  /** 新建/覆盖文档：给 id 时 PUT（幂等），否则 POST 自动生成。 */
  indexDocument(index: string, id: string | undefined, body: unknown, opts?: EsRequestOptions): Promise<EsResponse> {
    return id === undefined
      ? this.request('POST', `/${encodeURIComponent(index)}/_doc`, body, undefined, opts)
      : this.request('PUT', `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`, body, undefined, opts);
  }

  deleteDocument(index: string, id: string, opts?: EsRequestOptions): Promise<EsResponse> {
    return this.request('DELETE', `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`, undefined, undefined, opts);
  }

  /** 批量删除（_bulk；传 ids）。 */
  bulkDelete(index: string, ids: string[], opts?: EsRequestOptions): Promise<EsResponse> {
    if (!ids.length) {
      return Promise.resolve({ status: 200, headers: {}, body: { errors: false, items: [] }, tookMs: 0 });
    }
    const lines: string[] = [];
    for (const id of ids) {
      lines.push(JSON.stringify({ delete: { _index: index, _id: id } }));
    }
    const payload = `${lines.join('\n')}\n`;
    return this.request('POST', '/_bulk', payload, undefined, opts);
  }
}