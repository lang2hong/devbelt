import type { RedisConnectionSession } from '../connection/connectionSession.js';

/**
 * Redis 上下文（P9 S7b）：为 AI 请求生成选中逻辑库的 keyspace 概览。
 *
 * 内容与预算：
 *  - `INFO keyspace` 全库概览（keys/expires，展示多库分布）；
 *  - 目标库 DBSIZE + `SCAN COUNT 200` 一轮采样（≤200 键）+ 前 50 键 `TYPE` 直方图；
 *  - 键前缀分组（`:` 切分首段，top 12）。
 *
 * 采样经 `client.runExclusive` 串行（SELECT 归一与恢复，和其他面板的 SELECT 事务
 * 互斥）；只读连接不切库，退化为 keyspace 概览（不报错、不阻塞）。
 */
export interface EngineContextSnapshot {
  text: string;
  estimatedTokens: number;
}

const SAMPLE_COUNT = 200;
const TYPE_SAMPLE_LIMIT = 50;
const MAX_PREFIX_GROUPS = 12;

export async function buildRedisContext(session: RedisConnectionSession, db: number): Promise<EngineContextSnapshot | null> {
  try {
    return await session.client.runExclusive(async () => {
      const keyspace = await session.client.info('keyspace').catch(() => '');
      const overall = parseKeyspace(keyspace);

      let targetKeys: number | undefined;
      let sampled: string[] = [];
      let typeHistogram: Array<[string, number]> = [];

      const canSelect = !session.client.isCluster && !session.readOnly;
      const previous = canSelect ? await readCurrentDb(session) : undefined;
      try {
        if (canSelect && db !== previous) {
          await session.client.sendCommand('SELECT', [db]);
        }
        targetKeys = parseNumber(await session.client.sendCommand('DBSIZE', []).catch(() => undefined));
        if (targetKeys !== undefined || canSelect) {
          const scan = await session.client.sendCommand('SCAN', ['0', 'COUNT', String(SAMPLE_COUNT)]).catch(() => undefined);
          sampled = parseScanKeys(scan);
          const types = new Map<string, number>();
          for (const key of sampled.slice(0, TYPE_SAMPLE_LIMIT)) {
            const type = await session.client.sendCommand('TYPE', [key]).catch(() => undefined);
            if (typeof type === 'string' && type !== 'none') types.set(type, (types.get(type) ?? 0) + 1);
          }
          typeHistogram = [...types.entries()].sort((a, b) => b[1] - a[1]);
        }
      } finally {
        if (canSelect && previous !== undefined && db !== previous) {
          await session.client.sendCommand('SELECT', [previous]).catch(() => undefined);
        }
      }

      if (targetKeys === undefined) targetKeys = overall.get(db);
      const lines: string[] = [`# Redis keyspace (logical db ${db})`];
      lines.push(`Total keys (db ${db}): ${targetKeys ?? 'unknown'}`);
      if (sampled.length > 0) {
        lines.push(`Sampled ${sampled.length} keys (SCAN COUNT ${SAMPLE_COUNT})`);
        if (typeHistogram.length > 0) {
          lines.push(`Types (sampled, ≤${TYPE_SAMPLE_LIMIT}): ${typeHistogram.map(([t, n]) => `${t}×${n}`).join(' ')}`);
        }
        const prefixes = topPrefixes(sampled);
        if (prefixes.length > 0) {
          lines.push(`Top key prefixes: ${prefixes.map(([p, n]) => `${p} (${n})`).join(' ')}`);
        }
      }
      if (overall.size > 1) {
        lines.push(
          `All databases: ${[...overall.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([n, keys]) => `db${n}=${keys} keys`)
            .join(' ')}`,
        );
      }
      lines.push('Only reference keys/patterns listed above or visible in the connection; never invent keys.');

      const text = lines.join('\n');
      return { text, estimatedTokens: Math.max(1, Math.ceil(text.length / 4)) };
    });
  } catch {
    return null;
  }
}

function parseKeyspace(info: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const match of info.matchAll(/^db(\d+):keys=(\d+)/gm)) {
    out.set(Number(match[1]), Number(match[2]));
  }
  return out;
}

async function readCurrentDb(session: RedisConnectionSession): Promise<number | undefined> {
  try {
    const raw = await session.client.sendCommand('CLIENT', ['INFO']);
    const match = typeof raw === 'string' ? raw.match(/(?:^|\s)db=(\d+)/) : undefined;
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function parseScanKeys(reply: unknown): string[] {
  if (!Array.isArray(reply) || reply.length < 2) return [];
  const second = reply[1];
  if (Array.isArray(second)) return second.map((k) => String(k));
  return reply.slice(1).map((k) => String(k));
}

function parseNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function topPrefixes(keys: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const idx = key.indexOf(':');
    const prefix = idx > 0 ? `${key.slice(0, idx)}:` : '(no prefix)';
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PREFIX_GROUPS);
}