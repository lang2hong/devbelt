import type { EsClusterSnapshot, EsDocHit, EsErrorInfo, EsFieldInfo, EsIndexSummary, EsIndexTruncated, EsLogEntryView, EsNodeSummary, EsPanelTab, SavedEsQueryView } from '../../../../src/result/protocol';

export type { EsClusterSnapshot, EsDocHit, EsErrorInfo, EsFieldInfo, EsIndexSummary, EsIndexTruncated, EsLogEntryView, EsNodeSummary, EsPanelTab, SavedEsQueryView };

/** REST 控制台历史条目（纯前端态，不持久化）。 */
export interface EsRestHistoryItem {
  id: string;
  method: string;
  path: string;
  body: string | null;
  status: number;
  tookMs: number;
  at: number;
}

/**
 * 单通道“最新请求”追踪器：异步响应回来时用它判断是否仍属于当前请求。
 * 快速切换索引/连续搜索时，旧响应不得覆盖新状态。
 */
export interface LatestRequestTracker {
  begin(id: string): void;
  isCurrent(id: unknown): boolean;
  clear(): void;
}

export function createLatestRequestTracker(): LatestRequestTracker {
  let current: string | null = null;
  return {
    begin(id: string): void { current = id; },
    isCurrent(id: unknown): boolean { return typeof id === 'string' && id === current; },
    clear(): void { current = null; },
  };
}

/** DSL 历史项：保存查询目标索引，避免点击历史后跑错索引。 */
export interface EsDslHistoryItem {
  index: string;
  body: string;
  at: number;
}

/** 新历史置顶并限制条数（纯函数便于单测）。 */
export function pushDslHistory(history: readonly EsDslHistoryItem[], item: EsDslHistoryItem, limit = 10): EsDslHistoryItem[] {
  return [item, ...history].slice(0, Math.max(1, limit));
}

/** 百分比展示：缺失值显示 —，避免出现 `—%`。 */
export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value}%`;
}

/** 危险/只读确认请求（host 下发）。 */
export interface EsConfirmRequest {
  id: string;
  kind: 'dangerous' | 'readonly';
  reason: string;
  detail: string;
  typedIndexName: string | null;
}

/** REST 控制台请求体校验：空白 → 无 body；非法 JSON → ok=false；合法 → 原文透传。 */
export function validateRestBody(raw: string): { ok: true; body: string | null } | { ok: false } {
  const s = raw.trim();
  if (!s) return { ok: true, body: null };
  try {
    JSON.parse(s);
    return { ok: true, body: s };
  } catch {
    return { ok: false };
  }
}

/**
 * 从 `GET /{index}/_alias` 响应里提取别名名（形状：{ [index]: { aliases: { [alias]: {...} } } }）。
 * 容错：任何形状异常返回 []。
 */
export function aliasNames(aliases: unknown): string[] {
  if (!aliases || typeof aliases !== 'object') return [];
  const out = new Set<string>();
  for (const perIndex of Object.values(aliases as Record<string, unknown>)) {
    const aliasesOf = (perIndex as { aliases?: unknown } | null)?.aliases;
    if (!aliasesOf || typeof aliasesOf !== 'object') continue;
    for (const name of Object.keys(aliasesOf as Record<string, unknown>)) out.add(name);
  }
  return [...out].sort();
}

/**
 * 聚合表格化：对象值中 `{ buckets: [...] }` 形态 → 行（agg/key/doc_count/其余标量列）。
 * 无任何 buckets 时返回 null（调用方回退 JSON 树）。
 */
export interface EsAggRow {
  agg: string;
  key: string;
  docCount: string;
  extra: [string, string][];
}

export function aggregationRows(value: unknown): EsAggRow[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rows: EsAggRow[] = [];
  let found = false;
  for (const [agg, def] of Object.entries(value as Record<string, unknown>)) {
    const buckets = def && typeof def === 'object' && !Array.isArray(def)
      ? (def as { buckets?: unknown }).buckets
      : undefined;
    if (!Array.isArray(buckets)) continue;
    found = true;
    for (const b of buckets) {
      if (b && typeof b === 'object' && !Array.isArray(b)) {
        const o = b as Record<string, unknown>;
        const key = o.key_as_string ?? o.key ?? '';
        const extra: [string, string][] = [];
        for (const [k, v] of Object.entries(o)) {
          if (k === 'key' || k === 'key_as_string' || k === 'doc_count') continue;
          if (v === null || typeof v !== 'object') extra.push([k, String(v)]);
        }
        rows.push({ agg, key: String(key), docCount: String(o.doc_count ?? ''), extra });
      } else {
        rows.push({ agg, key: String(b), docCount: '', extra: [] });
      }
    }
  }
  return found ? rows : null;
}

/** 文档保存路径：带版本号时拼 if_seq_no/if_primary_term（N2 乐观并发）；否则整文档 PUT。 */
export function docSavePath(index: string, docId: string, seqNo: number | null, primaryTerm: number | null): string {
  const base = `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(docId)}`;
  if (seqNo === null || primaryTerm === null) return base;
  return `${base}?if_seq_no=${seqNo}&if_primary_term=${primaryTerm}`;
}

/** ES 错误体 reason（`error.reason` 或 `error` 字符串）；无则 null（N3：op 失败展示可读原因）。 */
export function esErrorReason(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const err = (body as Record<string, unknown>).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const reason = (err as Record<string, unknown>).reason;
    if (typeof reason === 'string') return reason;
  }
  return null;
}

/** tab 数据就绪状态（切回 tab 时判定是否需要首次懒加载）。 */
export interface EsTabLoadState {
  indices: boolean;
  index: boolean;
  docs: boolean;
  nodes: boolean;
}

/**
 * 切到某 tab 是否需要首次懒加载：已有数据 → false（保留现场，不重拉不闪空）；
 * cluster/rest/dsl/log 不依赖这些缓存数据（dsl/log 由调用方自行轻量刷新）。
 */
export function shouldAutoLoad(tab: EsPanelTab, state: EsTabLoadState): boolean {
  switch (tab) {
    case 'indices': return !state.indices;
    case 'index': return !state.index;
    case 'documents': return !state.docs;
    case 'nodes': return !state.nodes;
    default: return false;
  }
}

/** 请求体是否可用于该方法：ES 支持 GET 带 body（如 GET /idx/_search）；HEAD 无意义。 */
export function bodyAllowedFor(method: string): boolean {
  return method.toUpperCase() !== 'HEAD';
}

/** 搜索模式自动识别：以 `{` 开头视为 DSL（完整 search body），否则文本 query_string。 */
export function detectSearchMode(input: string): 'text' | 'dsl' {
  return input.trimStart().startsWith('{') ? 'dsl' : 'text';
}

/** 文本 → DSL search body（无缝升级时预填）。 */
export function textToSearchBody(text: string): string {
  return JSON.stringify({ query: { query_string: { query: text.trim() } } }, null, 2);
}

/** DSL body 校验：非空、可解析、对象（非数组/标量）。 */
export function validateDslBody(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  try {
    const v = JSON.parse(s);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * 字段建议过滤：按路径包含 prefix（不区分大小写）截取前 limit 个；prefix 空 → 全部。
 */
export function fieldSuggestions(fields: EsFieldInfo[], prefix: string, limit = 50): EsFieldInfo[] {
  const p = prefix.trim().toLowerCase();
  const list = p ? fields.filter((f) => f.path.toLowerCase().includes(p)) : fields;
  return list.slice(0, limit);
}

/**
 * 索引操作确认分级（S3 修订）：仅中断/高负载类操作弹本地确认；
 * open/refresh/flush 直接执行；delete 由 host 侧 typed 强确认兜底。
 */
export function needsConfirm(action: string): boolean {
  return action === 'close' || action === 'forcemerge';
}

/**
 * JSON 树过滤：键名路径（含祖先键）命中 query（不区分大小写）时保留整个子树；
 * 数组按元素过滤；空对象/空数组剪掉。query 为空 → 原样返回。
 */
export function filterJson(value: unknown, query: string): unknown {
  const q = query.trim().toLowerCase();
  if (!q) return value;
  return filterNode(value, q, '');
}

function filterNode(value: unknown, q: string, path: string): unknown {
  if (value === null || typeof value !== 'object') {
    // 键路径或原始值命中都保留（字段搜索常按字段名/类型值）。
    return path.toLowerCase().includes(q) || String(value).toLowerCase().includes(q) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => filterNode(v, q, path)).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  const obj = value as Record<string, unknown>;
  // 祖先/自身路径命中 → 整个子树保留。
  if (path.toLowerCase().includes(q)) return value;
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key of Object.keys(obj)) {
    const child = filterNode(obj[key], q, path ? `${path}.${key}` : key);
    if (child !== undefined) {
      out[key] = child;
      kept += 1;
    }
  }
  return kept ? out : undefined;
}