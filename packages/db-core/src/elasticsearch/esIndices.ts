/**
 * ES 索引元数据解析（P8 S3）。
 *
 * `_cat/indices?format=json` 的字段名/缺失情况随版本与参数漂移（7.x/8.x、hidden 索引、
 * 未分配分片等），这里统一归一为稳定结构供树与索引列表使用；解析失败/字段缺失不抛错
 * （返回 null 字段），由 UI 容错展示。
 */

export interface EsIndexSummary {
  name: string;
  /** 归一后的健康色（未知值 → null）。 */
  health: 'green' | 'yellow' | 'red' | null;
  /** open / close / 其它原样。 */
  status: string | null;
  primaryShards: number | null;
  replicas: number | null;
  /** 文档数（cat API 为字符串，可能带 -）。 */
  docsCount: string | null;
  storeSize: string | null;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function rowHealth(v: unknown): EsIndexSummary['health'] {
  return v === 'green' || v === 'yellow' || v === 'red' ? v : null;
}

/** 解析 `_cat/indices` JSON 行（数组）；非数组输入返回 []。 */
export function parseCatIndices(input: unknown): EsIndexSummary[] {
  if (!Array.isArray(input)) return [];
  const out: EsIndexSummary[] = [];
  for (const row of input) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name = asString(r.index);
    if (!name) continue;
    out.push({
      name,
      health: rowHealth(r.health),
      status: asString(r.status),
      primaryShards: asNumber(r.pri),
      replicas: asNumber(r.rep),
      docsCount: asString(r['docs.count']),
      storeSize: asString(r['store.size']),
    });
  }
  return out;
}

/** 健康色排序权重（green < yellow < red；未知最后），同级按名称。 */
const HEALTH_ORDER: Record<string, number> = { green: 0, yellow: 1, red: 2 };

/** 稳定排序：health（可配）→ 名称。 */
export function sortIndexSummaries(items: EsIndexSummary[], by: 'name' | 'health' = 'name', desc = false): EsIndexSummary[] {
  const sorted = [...items].sort((a, b) => {
    if (by === 'health') {
      const ha = a.health === null ? 3 : HEALTH_ORDER[a.health];
      const hb = b.health === null ? 3 : HEALTH_ORDER[b.health];
      if (ha !== hb) return ha - hb;
    }
    return a.name.localeCompare(b.name);
  });
  return desc ? sorted.reverse() : sorted;
}