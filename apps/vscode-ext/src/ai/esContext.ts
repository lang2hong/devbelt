import type { ElasticsearchConnectionSession } from '../connection/connectionSession.js';
import type { EngineContextSnapshot } from './redisContext.js';

/**
 * Elasticsearch 上下文（P9 S7c）：为 AI 请求生成选中索引的 mapping 概览。
 *
 * 内容与预算：字段名 + 类型（object/nested 递归到 3 层、点号路径），≤200 字段、
 * 超限截断标注；不拉样本文档（体积/隐私）。失败 → null（聊天降级无上下文）。
 */
const MAX_FIELDS = 200;
const MAX_DEPTH = 3;

export async function buildEsContext(
  session: ElasticsearchConnectionSession,
  index: string,
): Promise<EngineContextSnapshot | null> {
  try {
    const res = await session.es.request('GET', `/${encodeURIComponent(index)}/_mapping`);
    if (res.status >= 400 || !res.body || typeof res.body !== 'object') return null;
    const mapping = extractProperties(res.body, index);
    if (!mapping) return null;

    const fields: string[] = [];
    flatten(mapping, '', 0, fields);
    const truncated = fields.length > MAX_FIELDS;
    const shown = fields.slice(0, MAX_FIELDS);

    const lines = [
      `# Elasticsearch mapping (index: ${index})`,
      `Fields (${fields.length}${truncated ? ', truncated' : ''}):`,
      ...shown.map((line) => `- ${line}`),
      'Only reference the fields listed above; never invent fields.',
    ];
    const text = lines.join('\n');
    return { text, estimatedTokens: Math.max(1, Math.ceil(text.length / 4)) };
  } catch {
    return null;
  }
}

function extractProperties(body: unknown, index: string): Record<string, unknown> | null {
  const root = body as Record<string, unknown>;
  const entry = (root[index] ?? Object.values(root)[0]) as Record<string, unknown> | undefined;
  const mappings = entry?.mappings as Record<string, unknown> | undefined;
  if (!mappings) return null;
  const direct = mappings.properties as Record<string, unknown> | undefined;
  if (direct) return direct;
  const doc = mappings._doc as Record<string, unknown> | undefined;
  const legacy = doc?.properties as Record<string, unknown> | undefined;
  return legacy ?? null;
}

function flatten(properties: Record<string, unknown>, prefix: string, depth: number, out: string[]): void {
  if (out.length > MAX_FIELDS + 1) return;
  for (const [name, raw] of Object.entries(properties)) {
    if (name.startsWith('_')) continue;
    const meta = raw as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== 'object') continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const type = typeof meta.type === 'string' ? meta.type : undefined;
    const children = meta.properties as Record<string, unknown> | undefined;
    if (children && depth < MAX_DEPTH) {
      out.push(`${path} (object)`);
      flatten(children, path, depth + 1, out);
    } else if (type) {
      const note = type === 'date' && typeof meta.format === 'string' ? ` (${meta.format})` : '';
      out.push(`${path}: ${type}${note}`);
    } else if (children) {
      out.push(`${path} (object, nested fields omitted)`);
    }
  }
}