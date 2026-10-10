/**
 * ES 文档/查询/节点解析（P8 S4）。
 *
 * 面向 `_search` / `_cat/nodes` 响应做稳定归一：7.x/8.x 的 total（对象 vs 数字）、
 * 缺失字段、空 hits 等都不抛错；聚合保持原始 JSON 交 UI 渲染。
 */

/** 一条文档命中（source 保留原始 JSON）。 */
export interface EsDocHit {
  index: string | null;
  id: string;
  score: number | null;
  source: unknown;
  /** search_after 游标（本命中对应的 sort 值；无 sort → null）。 */
  sort: unknown[] | null;
  /** 乐观并发版本（编辑保存时经 if_seq_no/if_primary_term 回传；缺省 null）。 */
  seqNo: number | null;
  primaryTerm: number | null;
}

/** `_search` 响应归一（hits/total/took/timed_out/aggregations）。 */
export interface EsSearchSummary {
  hits: EsDocHit[];
  total: number | null;
  took: number | null;
  timedOut: boolean | null;
  aggregations: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** total 兼容 ES7+ 的 { value, relation } 与更早的数字形式。 */
function parseTotal(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const obj = asRecord(v);
  if (obj && typeof obj.value === 'number') return obj.value;
  return null;
}

/** 解析 `_search` 响应；非对象输入返回空结果。 */
export function parseSearchResponse(input: unknown): EsSearchSummary {
  const body = asRecord(input);
  const hitsObj = body ? asRecord(body.hits) : null;
  const rawHits = hitsObj && Array.isArray(hitsObj.hits) ? hitsObj.hits : [];
  const hits: EsDocHit[] = [];
  for (const h of rawHits) {
    const hit = asRecord(h);
    if (!hit) continue;
    const id = typeof hit._id === 'string' ? hit._id : null;
    if (id === null) continue;
    hits.push({
      index: typeof hit._index === 'string' ? hit._index : null,
      id,
      score: typeof hit._score === 'number' ? hit._score : null,
      source: hit._source ?? null,
      sort: Array.isArray(hit.sort) ? hit.sort : null,
      seqNo: typeof hit._seq_no === 'number' ? hit._seq_no : null,
      primaryTerm: typeof hit._primary_term === 'number' ? hit._primary_term : null,
    });
  }
  return {
    hits,
    total: hitsObj ? parseTotal(hitsObj.total) : null,
    took: body && typeof body.took === 'number' ? body.took : null,
    timedOut: body && typeof body.timed_out === 'boolean' ? body.timed_out : null,
    aggregations: body?.aggregations ?? null,
  };
}

/** search_after 游标：取最后一条命中的 sort（无 sort → null，表示不能续页）。 */
export function nextSearchAfter(hits: EsDocHit[]): unknown[] | null {
  const last = hits[hits.length - 1];
  return last?.sort ?? null;
}

/** `_cat/nodes` 行归一。 */
export interface EsNodeSummary {
  name: string;
  ip: string | null;
  heapPercent: number | null;
  ramPercent: number | null;
  cpu: number | null;
  load1m: number | null;
  role: string | null;
  /** `master` 列：`*`（当前 master）/ `-` / `m` 等原样。 */
  master: string | null;
}

/** mapping 提取出的字段（点路径 + 类型；多字段为 `path.raw` 形式）。 */
export interface EsFieldInfo {
  path: string;
  type: string;
}

/**
 * 从 `GET /{index}/_mapping` 响应提取字段清单（递归 `properties` 与多字段 `fields`）。
 *
 * 容错：非对象/缺 mappings 返回 []; `type` 缺失记 object；上限 `limit`（默认 500）截断，
 * 防止超大 mapping 把建议列表撑爆。
 */
export function collectMappingFields(mapping: unknown, limit = 500): EsFieldInfo[] {
  const out = new Map<string, string>();
  const visit = (props: unknown, prefix: string): void => {
    if (!props || typeof props !== 'object' || Array.isArray(props)) return;
    for (const [name, def] of Object.entries(props as Record<string, unknown>)) {
      if (out.size >= limit) return;
      const path = prefix ? `${prefix}.${name}` : name;
      const d = def && typeof def === 'object' && !Array.isArray(def) ? (def as Record<string, unknown>) : null;
      out.set(path, typeof d?.type === 'string' ? d.type : 'object');
      if (d) {
        if (d.properties) visit(d.properties, path);
        // 多字段（`name.raw` 等）：fields 下每个键是一个子字段。
        if (d.fields) visit(d.fields, path);
      }
    }
  };
  const root = asRecord(mapping);
  if (!root) return [];
  for (const value of Object.values(root)) {
    const mappings = asRecord(asRecord(value)?.mappings);
    if (mappings) visit(mappings.properties, '');
  }
  return [...out.entries()].map(([path, type]) => ({ path, type }));
}

function asNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 解析 `_cat/nodes?format=json`；非数组 → []。 */
export function parseCatNodes(input: unknown): EsNodeSummary[] {
  if (!Array.isArray(input)) return [];
  const out: EsNodeSummary[] = [];
  for (const row of input) {
    const r = asRecord(row);
    if (!r) continue;
    const name = typeof r.name === 'string' ? r.name : null;
    if (!name) continue;
    out.push({
      name,
      ip: typeof r.ip === 'string' ? r.ip : null,
      heapPercent: asNumber(r['heap.percent']),
      ramPercent: asNumber(r['ram.percent']),
      cpu: asNumber(r.cpu),
      load1m: asNumber(r.load_1m),
      role: typeof r['node.role'] === 'string' ? r['node.role'] : null,
      master: typeof r.master === 'string' ? r.master : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}