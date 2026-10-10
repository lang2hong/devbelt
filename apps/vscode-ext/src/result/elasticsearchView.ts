/**
 * Elasticsearch 面板（P8 S2）。
 *
 * 单面板多 tab（S2：Cluster / REST 控制台）；按连接单实例（同连接再次打开只切 tab/聚焦）。
 * 所有 HTTP I/O 经会话的 EsClient 在 extension host 执行；webview 只收渲染数据。
 *
 * 安全边界（对齐 P7）：
 *  - 危险操作在 **host 侧**判定并要求确认（typedIndexName 需精确匹配）；
 *  - 只读连接：EsClient 切面返回 403 → host 转为「单条解锁」确认；
 *  - 写请求落 AuditLogger（method/path/耗时，不含 body）；
 *  - 面板关闭 abort in-flight 请求；不关闭共享会话（由 ConnectionManager 持有）。
 */
import type { EsDocHit, EsQuery, EsResponse } from '@devbelt/db-core';
import { isDangerousRequest, collectMappingFields, nextSearchAfter, parseCatIndices, parseCatNodes, parseEsError, parseSearchResponse, sortIndexSummaries } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { ConnectionManager } from '../connection/connectionManager';
import type { ElasticsearchConnectionSession } from '../connection/connectionSession';
import { BaseWebView } from './baseWebView';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';
import type { EsDslStore } from './esDslStore';
import { getEsRequestLog, subscribeEsRequestLog } from './esRequestLogStore';
import type { EsErrorInfo, EsFieldInfo, EsPanelTab, EsUpMessage } from './protocol';

/** 响应体超过 1MB 截断（postMessage 开销保护）；完整内容经 REST 控制台重新请求/后续下载。 */
const RESPONSE_TRUNCATE_BYTES = 1024 * 1024;

/** 文档浏览页大小（search_after）。 */
const DOCS_PAGE_SIZE = 50;

/** JSON 解析失败的哨兵（与合法 undefined body 区分）。 */
const INVALID_JSON = Symbol('invalid-json');

interface PendingConfirm {
  msg: Extract<EsUpMessage, { type: 'esRest' }>;
  kind: 'dangerous' | 'readonly';
  typedIndexName?: string;
}

function panelTitle(conn: SavedConnection): string {
  return `ES @ ${conn.name || conn.host}`;
}

export class ElasticsearchView extends BaseWebView {
  private static readonly instances = new Map<string, ElasticsearchView>();
  /** S4：DSL 保存查询存储（extension 激活时注入；未注入时保存能力关闭）。 */
  private static dslStore?: EsDslStore;
  private tab: EsPanelTab;
  /** S3/S4：当前索引面板目标（tab index/documents/dsl 时有效）。 */
  private indexName: string | null;
  /** 「两次 ready」后的 webview 已挂载（此前不发 config/数据）。 */
  private webviewReady = false;
  private pending?: PendingConfirm;
  private inflight?: AbortController;
  /** S4：请求日志订阅取消函数。 */
  private logUnsub?: () => void;
  /** S4.5：字段建议缓存（mapping 提取，per index）。 */
  private readonly fieldsCache = new Map<string, EsFieldInfo[]>();

  /** extension 激活时注入（Memento 后端）。 */
  static configureDslStore(store: EsDslStore): void {
    ElasticsearchView.dslStore = store;
  }

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    tab: EsPanelTab,
    indexName: string | null,
  ) {
    super('devbelt.elasticsearch', panelTitle(conn));
    this.tab = tab;
    this.indexName = indexName;
    this.manager.retain(conn.id);
    this.logUnsub = subscribeEsRequestLog(conn.id, (entry) => this.post({ type: 'esLogEntry', entry }));
  }

  /** 打开/聚焦面板；同连接已存在则切 tab（不重复创建）。 */
  static open(conn: SavedConnection, manager: ConnectionManager, tab: EsPanelTab = 'cluster', indexName?: string): ElasticsearchView {
    const existing = ElasticsearchView.instances.get(conn.id);
    if (existing) {
      existing.tab = tab;
      if (indexName !== undefined) existing.indexName = indexName;
      if (existing.webviewReady) existing.post({ type: 'esTab', tab, indexName: existing.indexName });
      existing.reveal();
      return existing;
    }
    const view = new ElasticsearchView(conn, manager, tab, indexName ?? null);
    ElasticsearchView.instances.set(conn.id, view);
    return view;
  }

  static find(connId: string): ElasticsearchView | undefined {
    return ElasticsearchView.instances.get(connId);
  }

  static closeAll(): void {
    for (const v of [...ElasticsearchView.instances.values()]) v.dispose();
    ElasticsearchView.instances.clear();
  }

  protected async handleMessage(msg: EsUpMessage): Promise<void> {
    if ((msg as { type?: string })?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        // mode 固定 elasticsearch；isZh 由 BaseWebView.post 注入。
        this.post({ type: 'init', mode: 'elasticsearch' } as never);
        return;
      }
      this.webviewReady = true;
      await this.pushConfig();
      await this.pushCluster();
      return;
    }
    if (msg?.type === 'esRefreshCluster') { await this.pushCluster(); return; }
    if (msg?.type === 'esRest') { await this.handleRest(msg); return; }
    if (msg?.type === 'esConfirm') { await this.handleConfirm(msg); return; }
    if (msg?.type === 'esLoadIndices') { await this.pushIndices(); return; }
    if (msg?.type === 'esLoadIndex') { await this.pushIndex(msg.id, msg.name); return; }
    if (msg?.type === 'esLoadDocs') { await this.pushDocs(msg.id, msg.index, msg.searchAfter, msg.size, msg.query, msg.queryMode, msg.defaultOperator); return; }
    if (msg?.type === 'esGetDoc') { await this.pushDoc(msg.id, msg.index, msg.docId); return; }
    if (msg?.type === 'esRunDsl') { await this.runDsl(msg.id, msg.index, msg.body, msg.size); return; }
    if (msg?.type === 'esLoadNodes') { await this.pushNodes(); return; }
    if (msg?.type === 'esLoadSavedDsl') { await this.pushSavedDsl(); return; }
    if (msg?.type === 'esSaveDsl') { await this.saveDsl(msg.name, msg.index, msg.body); return; }
    if (msg?.type === 'esDeleteDsl') { await this.deleteDsl(msg.id); return; }
    if (msg?.type === 'esLoadLog') { this.post({ type: 'esLog', items: getEsRequestLog(this.conn.id) }); return; }
    // 未知消息静默忽略
  }

  protected onDispose(): void {
    super.onDispose();
    this.inflight?.abort();
    this.inflight = undefined;
    this.logUnsub?.();
    this.logUnsub = undefined;
    ElasticsearchView.instances.delete(this.conn.id);
    this.manager.release(this.conn.id);
  }

  private async session(): Promise<ElasticsearchConnectionSession> {
    const session = await this.manager.connect(this.conn);
    if (session.kind !== 'elasticsearch') throw new Error('connection is not an Elasticsearch session');
    return session;
  }

  private async pushConfig(): Promise<void> {
    this.post({
      type: 'esConfig',
      connName: this.conn.name || this.conn.host,
      host: this.conn.host,
      port: this.conn.port,
      protocol: this.conn.esProtocol === 'https' ? 'https' : 'http',
      pathPrefix: this.conn.esPathPrefix ?? null,
      readOnly: this.conn.readOnly === true,
      tab: this.tab,
      indexName: this.indexName,
      color: this.conn.color ?? null,
    });
  }

  /** S3：索引列表（`_cat/indices`，按名称排序）。 */
  private async pushIndices(): Promise<void> {
    try {
      const session = await this.session();
      const res = await session.es.request('GET', '/_cat/indices', undefined, {
        format: 'json',
        h: 'index,health,status,pri,rep,docs.count,store.size',
        s: 'index',
      });
      if (res.status >= 400) {
        this.post({ type: 'esIndexError', id: 'indices', name: '', message: parseReason(res) ?? `HTTP ${res.status}` });
        return;
      }
      this.post({ type: 'esIndices', items: sortIndexSummaries(parseCatIndices(res.body), 'name') });
    } catch (err) {
      this.post({ type: 'esIndexError', id: 'indices', name: '', message: (err as Error).message ?? String(err) });
    }
  }

  /** S3：索引详情（mapping/settings/aliases/stats，各自 1MB 截断）。 */
  private async pushIndex(id: string, name: string): Promise<void> {
    try {
      const session = await this.session();
      const p = `/${encodeURIComponent(name)}`;
      const [mapping, settings, aliases, stats] = await Promise.all([
        session.es.request('GET', `${p}/_mapping`),
        session.es.request('GET', `${p}/_settings`),
        session.es.request('GET', `${p}/_alias`),
        session.es.request('GET', `${p}/_stats`),
      ]);
      for (const res of [mapping, settings, aliases, stats]) {
        if (res.status >= 400) {
          this.post({ type: 'esIndexError', id, name, message: parseReason(res) ?? `HTTP ${res.status}` });
          return;
        }
      }
      const m = truncateJson(mapping.body);
      const s = truncateJson(settings.body);
      const a = truncateJson(aliases.body);
      const st = truncateJson(stats.body);
      this.post({
        type: 'esIndexData',
        id,
        name,
        mapping: m.value,
        settings: s.value,
        aliases: a.value,
        stats: st.value,
        truncated: { mapping: m.truncated, settings: s.truncated, aliases: a.truncated, stats: st.truncated },
      });
    } catch (err) {
      this.post({ type: 'esIndexError', id, name, message: (err as Error).message ?? String(err) });
    }
  }

  private async pushCluster(): Promise<void> {
    const session = await this.session();
    const [info, health, indices] = await Promise.all([
      session.es.clusterInfo(),
      session.es.clusterHealth(),
      session.es.request('GET', '/_cat/indices', undefined, { format: 'json', h: 'index' }),
    ]);
    const body = (info.status < 400 ? info.body : null) as { version?: { number?: string }; cluster_name?: string } | null;
    this.post({
      type: 'esCluster',
      snapshot: {
        version: body?.version?.number ?? null,
        clusterName: body?.cluster_name ?? null,
        health: (health.status < 400 ? health.body : null) as Record<string, unknown> | null,
        info: (body ?? null) as Record<string, unknown> | null,
        indicesCount: indices.status < 400 ? parseCatIndices(indices.body).length : null,
      },
    });
  }

  // ────────────────────────── S4：文档 / DSL / 节点 / 日志 ──────────────────────────

  /**
   * 文档浏览（S4.5）：文本（query_string + default_operator）或 DSL（完整 search body）
   * + sort=_doc + search_after 分页；随包下发 mapping 提取的字段建议。
   */
  private async pushDocs(
    id: string,
    index: string,
    searchAfter: unknown[] | null,
    size?: number,
    query?: string | null,
    queryMode: 'text' | 'dsl' = 'text',
    defaultOperator: 'OR' | 'AND' = 'OR',
  ): Promise<void> {
    try {
      const session = await this.session();
      const n = size && size > 0 ? Math.min(size, 500) : DOCS_PAGE_SIZE;
      const q = query?.trim();
      let body: Record<string, unknown>;
      if (!q) {
        body = { query: { match_all: {} } };
      } else if (queryMode === 'dsl') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(q);
        } catch {
          this.post({ type: 'esDocsError', id, index, error: { message: l10n('wv.es.invalidJson'), type: 'validation', reason: l10n('wv.es.invalidJson'), rootCause: [] } });
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          this.post({ type: 'esDocsError', id, index, error: { message: l10n('wv.es.invalidJson'), type: 'validation', reason: l10n('wv.es.invalidJson'), rootCause: [] } });
          return;
        }
        body = { ...(parsed as Record<string, unknown>) };
      } else {
        body = { query: { query_string: { query: q, default_operator: defaultOperator === 'AND' ? 'AND' : 'OR' } } };
      }
      // 用户 DSL 未给 sort/size 时补齐分页必需项；search_after 始终以 host 游标为准。
      if (!Array.isArray(body.sort)) body.sort = ['_doc'];
      if (typeof body.size !== 'number') body.size = n;
      if (searchAfter && searchAfter.length) body.search_after = searchAfter;
      const [res, fields] = await Promise.all([
        session.es.request('POST', `/${encodeURIComponent(index)}/_search`, body),
        this.mappingFields(session, index),
      ]);
      if (res.status >= 400) {
        this.post({ type: 'esDocsError', id, index, error: errorInfo(undefined, res) });
        return;
      }
      const s = parseSearchResponse(res.body);
      const capped = capHits(s.hits);
      this.post({
        type: 'esDocs',
        id,
        index,
        hits: capped.hits,
        total: s.total,
        searchAfter: nextSearchAfter(s.hits),
        truncated: capped.truncated,
        fields,
      });
    } catch (err) {
      this.post({ type: 'esDocsError', id, index, error: errorInfo(err) });
    }
  }

  /** 字段建议（mapping 提取；按索引缓存，失败降级为 [] 且不阻塞文档列表）。 */
  private async mappingFields(session: ElasticsearchConnectionSession, index: string): Promise<EsFieldInfo[]> {
    const cached = this.fieldsCache.get(index);
    if (cached) return cached;
    let fields: EsFieldInfo[] = [];
    try {
      const res = await session.es.request('GET', `/${encodeURIComponent(index)}/_mapping`);
      if (res.status < 400) fields = collectMappingFields(res.body);
    } catch {
      // 网络失败降级：无建议
    }
    this.fieldsCache.set(index, fields);
    return fields;
  }

  /** 按 _id 取单文档（404 → found=false，不视为错误）。 */
  private async pushDoc(id: string, index: string, docId: string): Promise<void> {
    try {
      const session = await this.session();
      const res = await session.es.request('GET', `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(docId)}`);
      if (res.status === 404) {
        this.post({ type: 'esDoc', id, index, docId, found: false, source: null, seqNo: null, primaryTerm: null });
        return;
      }
      if (res.status >= 400) {
        this.post({ type: 'esDocsError', id, index, error: errorInfo(undefined, res) });
        return;
      }
      const body = res.body as { _source?: unknown; _seq_no?: unknown; _primary_term?: unknown } | null;
      this.post({
        type: 'esDoc', id, index, docId, found: true,
        source: body?._source ?? body ?? null,
        seqNo: typeof body?._seq_no === 'number' ? body._seq_no : null,
        primaryTerm: typeof body?._primary_term === 'number' ? body._primary_term : null,
      });
    } catch (err) {
      this.post({ type: 'esDocsError', id, index, error: errorInfo(err) });
    }
  }

  /** DSL 查询：body 语法校验 → `_search` → hits/aggregations/指标。 */
  private async runDsl(id: string, index: string, body: string, size?: number): Promise<void> {
    let parsed: unknown;
    try {
      parsed = body.trim() ? JSON.parse(body) : {};
    } catch {
      this.post({ type: 'esDslError', id, index, error: { message: l10n('wv.es.invalidJson'), type: 'validation', reason: l10n('wv.es.invalidJson'), rootCause: [] } });
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.post({ type: 'esDslError', id, index, error: { message: l10n('wv.es.invalidJson'), type: 'validation', reason: l10n('wv.es.invalidJson'), rootCause: [] } });
      return;
    }
    try {
      const session = await this.session();
      const n = size && size > 0 ? Math.min(size, 500) : DOCS_PAGE_SIZE;
      const res = await session.es.request('POST', `/${encodeURIComponent(index)}/_search`, { ...(parsed as Record<string, unknown>), size: (parsed as Record<string, unknown>).size ?? n });
      if (res.status >= 400) {
        this.post({ type: 'esDslError', id, index, error: errorInfo(undefined, res) });
        return;
      }
      const s = parseSearchResponse(res.body);
      const capped = capHits(s.hits);
      const raw = truncateJson(res.body);
      this.post({
        type: 'esDslResult',
        id,
        index,
        took: s.took,
        timedOut: s.timedOut,
        total: s.total,
        hits: capped.hits,
        aggregations: s.aggregations,
        raw: raw.value,
        truncated: capped.truncated || raw.truncated,
      });
    } catch (err) {
      this.post({ type: 'esDslError', id, index, error: errorInfo(err) });
    }
  }

  /** Nodes tab：`_cat/nodes`。 */
  private async pushNodes(): Promise<void> {
    try {
      const session = await this.session();
      const res = await session.es.request('GET', '/_cat/nodes', undefined, {
        format: 'json',
        h: 'name,ip,heap.percent,ram.percent,cpu,load_1m,node.role,master',
      });
      if (res.status >= 400) {
        this.post({ type: 'esNodesError', error: errorInfo(undefined, res) });
        return;
      }
      this.post({ type: 'esNodes', items: parseCatNodes(res.body) });
    } catch (err) {
      this.post({ type: 'esNodesError', error: errorInfo(err) });
    }
  }

  /** 保存查询列表（Memento；未配置 store 时下发空列表）。 */
  private async pushSavedDsl(): Promise<void> {
    const store = ElasticsearchView.dslStore;
    const items = store
      ? store.list(this.conn.id).map((q) => ({ id: q.id, name: q.name, index: q.index, body: q.body, at: q.at }))
      : [];
    this.post({ type: 'esSavedDsl', items });
  }

  private async saveDsl(name: string, index: string, body: string): Promise<void> {
    const store = ElasticsearchView.dslStore;
    if (!store || !name.trim()) return;
    await store.save(this.conn.id, name, index, body);
    await this.pushSavedDsl();
  }

  private async deleteDsl(id: string): Promise<void> {
    const store = ElasticsearchView.dslStore;
    if (!store) return;
    await store.remove(id);
    await this.pushSavedDsl();
  }

  /** 危险确认 → 只读 403 转单条解锁 → 执行 + 审计。 */
  private async handleRest(msg: Extract<EsUpMessage, { type: 'esRest' }>): Promise<void> {
    const session = await this.session();
    const method = String(msg.method ?? 'GET').toUpperCase();
    // 原始输入（含 query/fragment）用于审计与确认展示；实际请求用拆出的 path/query。
    const rawInput = String(msg.path ?? '').trim();
    if (!rawInput) {
      this.postResult(msg.id, { status: 0, headers: {}, body: { error: { type: 'validation', reason: 'path is required' } }, tookMs: 0 });
      return;
    }
    const parsedBody = this.parseBody(msg.body);
    if (parsedBody === INVALID_JSON) {
      this.postResult(msg.id, { status: 0, headers: {}, body: { error: { type: 'validation', reason: l10n('wv.es.invalidJson') } }, tookMs: 0 });
      return;
    }
    // H1：`?v/?pretty` 等参数经 EsQuery 通道透传（此前被静默丢弃）；`#` 片段丢弃。
    const { path, query } = splitEsPathQuery(rawInput);
    if (!path) {
      this.postResult(msg.id, { status: 0, headers: {}, body: { error: { type: 'validation', reason: 'path is required' } }, tookMs: 0 });
      return;
    }

    // 1) 危险操作：host 侧确认（UI 失效也拦住）；确认需精确匹配 typedIndexName。
    const danger = isDangerousRequest(method, path, parsedBody as unknown);
    if (danger.dangerous && msg.confirmedDanger !== true) {
      this.pending = { msg, kind: 'dangerous', typedIndexName: danger.typedIndexName };
      this.post({
        type: 'esConfirmRequired',
        id: msg.id,
        kind: 'dangerous',
        reason: danger.reason ?? 'dangerous',
        detail: `${method} ${rawInput}`,
        typedIndexName: danger.typedIndexName ?? null,
      });
      return;
    }

    // 2) 执行（只读 force 解锁经 force 参数）。
    let res: EsResponse;
    try {
      this.inflight?.abort();
      this.inflight = new AbortController();
      res = await session.es.request(method, path, parsedBody as unknown, query, { force: msg.force === true, signal: this.inflight.signal });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.postResult(msg.id, { status: 0, headers: {}, body: { error: { type: 'network_error', reason: message } }, tookMs: 0 });
      return;
    }
    // 3) 只读拦截（仅切面伪造的 403 哨兵；真实 ES 权限 403 不误弹解锁）。
    if (res.status === 403 && msg.force !== true && this.conn.readOnly === true && isReadOnlyGateResponse(res)) {
      this.pending = { msg, kind: 'readonly' };
      this.post({
        type: 'esConfirmRequired',
        id: msg.id,
        kind: 'readonly',
        reason: 'read-only mode',
        detail: `${method} ${rawInput}`,
        typedIndexName: null,
      });
      return;
    }
    this.postResult(msg.id, res);
    // N4：写请求成功 → 字段建议缓存失效（mapping 可能已变；REST 控制台 PUT _mapping 也覆盖）。
    if (res.status < 300 && method !== 'GET' && method !== 'HEAD') this.fieldsCache.clear();
    if (method !== 'GET' && method !== 'HEAD') {
      AuditLogger.tryLog({
        action: 'es_rest',
        connName: this.conn.name || this.conn.host,
        database: '',
        sql: `${method} ${rawInput}`,
        costTime: res.tookMs,
      });
    }
  }

  /** 确认结果：dangerous 需 typedIndexName 精确匹配；readonly 以 force 单条解锁重发。 */
  private async handleConfirm(msg: Extract<EsUpMessage, { type: 'esConfirm' }>): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || pending.msg.id !== msg.id) return;
    if (!msg.accept) {
      this.postResult(msg.id, { status: 0, headers: {}, body: { error: { type: 'cancelled', reason: 'cancelled by user' } }, tookMs: 0 });
      return;
    }
    if (pending.kind === 'dangerous' && pending.typedIndexName !== undefined) {
      if (String(msg.typedName ?? '') !== pending.typedIndexName) {
        this.postResult(msg.id, { status: 0, headers: {}, body: { error: { type: 'typed_confirm_mismatch', reason: l10n('wv.es.confirm.typedMismatch') } }, tookMs: 0 });
        return;
      }
    }
    await this.handleRest({ ...pending.msg, confirmedDanger: true, force: pending.kind === 'readonly' ? true : pending.msg.force });
  }

  private parseBody(body: string | null | undefined): unknown | typeof INVALID_JSON {
    if (body === null || body === undefined || body.trim() === '') return undefined;
    try { return JSON.parse(body); } catch { return INVALID_JSON; }
  }

  private postResult(id: string, res: EsResponse): void {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined) headers[k] = Array.isArray(v) ? v : String(v);
    }
    const t = truncateJson(res.body ?? null);
    this.post({ type: 'esRestResult', id, status: res.status, tookMs: res.tookMs, headers, body: t.value, truncated: t.truncated });
  }
}

/**
 * 拆分用户输入的路径：`#` 片段丢弃；`?` 后参数经 EsQuery 通道透传（H1，防静默丢失）。
 * 导出的纯函数便于单测；实际请求的 path 不含 query。
 */
export function splitEsPathQuery(input: string): { path: string; query: EsQuery | undefined } {
  const noHash = input.split('#')[0];
  const qIdx = noHash.indexOf('?');
  if (qIdx < 0) return { path: noHash.trim(), query: undefined };
  return {
    path: noHash.slice(0, qIdx).trim(),
    query: Object.fromEntries(new URLSearchParams(noHash.slice(qIdx + 1))),
  };
}

/** 只读切面伪造 403 的独有形状（真实 ES 权限 403 为 security_exception 等，不得触发解锁）。 */
function isReadOnlyGateResponse(res: EsResponse): boolean {
  const err = (res.body as { error?: { type?: unknown; reason?: unknown } } | null)?.error;
  return !!err && err.type === 'forbidden' && err.reason === 'read-only mode';
}

/** 错误体 reason（结构化优先，缺省 undefined）。 */
function parseReason(res: EsResponse): string | undefined {
  return parseEsError(res.body)?.reason;
}

/** 归一错误信息（结构化 ES 错误优先；网络错误取 message）。 */
function errorInfo(err: unknown, res?: EsResponse): EsErrorInfo {
  const parsed = res ? parseEsError(res.body) : undefined;
  const fallback = res ? `HTTP ${res.status}` : (err as Error)?.message ?? String(err);
  return {
    message: parsed?.reason ?? fallback,
    type: parsed?.type ?? null,
    reason: parsed?.reason ?? null,
    rootCause: (parsed?.rootCause ?? []).map((c) => c.reason).filter((r): r is string => !!r),
  };
}

/** 文档页内截断：单文档超大 → source 截为字符串；累计超 1MB → 截断后续文档。 */
function capHits(hits: EsDocHit[]): { hits: EsDocHit[]; truncated: boolean } {
  let bytes = 0;
  let truncated = false;
  const out: EsDocHit[] = [];
  for (const h of hits) {
    const text = JSON.stringify(h.source ?? null);
    if (text.length > RESPONSE_TRUNCATE_BYTES) {
      out.push({ ...h, source: text.slice(0, RESPONSE_TRUNCATE_BYTES) });
      truncated = true;
      break;
    }
    if (out.length && bytes + text.length > RESPONSE_TRUNCATE_BYTES) {
      truncated = true;
      break;
    }
    bytes += text.length;
    out.push(h);
  }
  return { hits: out, truncated };
}

/** JSON 值超 1MB 截断为前缀字符串（postMessage/内存保护）。 */
function truncateJson(v: unknown): { value: unknown; truncated: boolean } {
  try {
    const text = JSON.stringify(v);
    if (text.length > RESPONSE_TRUNCATE_BYTES) {
      return { value: text.slice(0, RESPONSE_TRUNCATE_BYTES), truncated: true };
    }
  } catch {
    return { value: String(v), truncated: false };
  }
  return { value: v, truncated: false };
}