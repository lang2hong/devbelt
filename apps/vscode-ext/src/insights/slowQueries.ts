import { scanSql, type SqlScanOptions } from '@devbelt/db-core/sql';
import type { QueryHistoryEntry } from '../history/historyStore';

export type SlowQuerySort = 'total' | 'avg' | 'max' | 'count';
export type SlowQueryRange = '24h' | '7d' | '30d' | 'all';

export interface SlowQueryFilter {
  connectionId?: string;
  range?: SlowQueryRange;
  keyword?: string;
  sort?: SlowQuerySort;
  limit?: number;
}

export interface SlowQueryGroup {
  /** Stable key: connection + database + fingerprint. */
  key: string;
  fingerprint: string;
  /** Most recent raw SQL of the group (used for "open SQL" / EXPLAIN). */
  sampleSql: string;
  connectionId?: string;
  connection: string;
  database?: string;
  count: number;
  failed: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  lastTime: number;
}

const RANGE_MS: Record<Exclude<SlowQueryRange, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * A record identical to the previous one (same SQL, cost and outcome) this close
 * in time is treated as one run logged twice. Any difference means a real execution.
 */
export const DUPLICATE_WINDOW_MS = 1000;
export const DEFAULT_SLOW_QUERY_LIMIT = 100;

/** Resolves the dialect scan options of a history entry's connection (undefined = unknown connection). */
export type ScanOptionsResolver = (connectionId: string | undefined) => SqlScanOptions | undefined;

export interface SlowQueryStats {
  groups: SlowQueryGroup[];
  /** History entries that passed every filter and took part in the aggregation. */
  scanned: number;
}

const NUMBER_LITERAL = /(?<![\w$.])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?![\w$])/gi;
const IN_LIST = /\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi;

/**
 * Template of a statement for grouping: string/number literals become `?`,
 * `IN (?, ?, …)` collapses to `IN (?)`, comments are dropped and whitespace is
 * normalized. Identifiers and structure are kept so different queries never merge.
 */
export function fingerprintSql(sql: string, options: SqlScanOptions = {}): string {
  let out = '';
  for (const seg of scanSql(sql, options)) {
    const text = sql.slice(seg.start, seg.end);
    if (seg.kind === 'code') out += text.replace(NUMBER_LITERAL, '?');
    else if (seg.kind === 'execComment') out += text;
    else if (seg.kind === 'string' || seg.kind === 'dollar') out += '?';
    else out += ' ';
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(IN_LIST, 'IN (?)')
    .replace(/\s*;\s*$/, '')
    .trim();
}

/** History rows that are not real SQL (bulk-operation summaries like `-- Imported …`). */
function isSummary(sql: string): boolean {
  return sql.trimStart().startsWith('--');
}

/**
 * Group local history by connection + database + SQL template.
 *
 * Entries are expected newest-first (HistoryStore order); the most recent SQL
 * of each group becomes its sample. A second record that is identical (SQL, cost,
 * outcome) and falls within `DUPLICATE_WINDOW_MS` of the previous one is dropped;
 * repeated runs that differ in cost or outcome are all counted.
 *
 * `scanOptionsFor` supplies the dialect of each entry's connection so that
 * MySQL `#` comments, `--2` arithmetic and backslash escapes fingerprint correctly.
 */
export function aggregateSlowQueriesWithStats(
  entries: readonly QueryHistoryEntry[],
  filter: SlowQueryFilter = {},
  now = Date.now(),
  scanOptionsFor?: ScanOptionsResolver,
): SlowQueryStats {
  const since = filter.range && filter.range !== 'all' ? now - RANGE_MS[filter.range] : undefined;
  const keyword = filter.keyword?.trim().toLowerCase();
  const groups = new Map<string, SlowQueryGroup>();
  const lastSeen = new Map<string, number>();
  const optionsCache = new Map<string, SqlScanOptions>();
  const optionsFor = (connectionId: string | undefined): SqlScanOptions => {
    if (!scanOptionsFor) return {};
    const cacheKey = connectionId ?? '';
    let options = optionsCache.get(cacheKey);
    if (!options) {
      options = scanOptionsFor(connectionId) ?? {};
      optionsCache.set(cacheKey, options);
    }
    return options;
  };
  let scanned = 0;

  for (const entry of entries) {
    const sql = entry.sql ?? '';
    if (!sql.trim() || isSummary(sql)) continue;
    if (filter.connectionId && entry.connectionId !== filter.connectionId) continue;
    if (since !== undefined && (entry.time ?? 0) < since) continue;

    const fingerprint = fingerprintSql(sql, optionsFor(entry.connectionId));
    if (!fingerprint) continue;
    if (keyword && !sql.toLowerCase().includes(keyword) && !fingerprint.toLowerCase().includes(keyword)) continue;

    const key = `${entry.connectionId ?? entry.connection}\u0000${entry.database ?? ''}\u0000${fingerprint}`;
    const time = entry.time ?? 0;
    const cost = Number.isFinite(entry.costTime) ? Math.max(0, entry.costTime) : 0;
    const dupKey = `${key}\u0000${sql}\u0000${cost}\u0000${entry.failed ? 1 : 0}`;
    const previous = lastSeen.get(dupKey);
    if (previous !== undefined && Math.abs(previous - time) <= DUPLICATE_WINDOW_MS) continue;
    lastSeen.set(dupKey, time);
    scanned += 1;

    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        key,
        fingerprint,
        sampleSql: sql,
        ...(entry.connectionId ? { connectionId: entry.connectionId } : {}),
        connection: entry.connection,
        ...(entry.database ? { database: entry.database } : {}),
        count: 1,
        failed: entry.failed ? 1 : 0,
        totalMs: cost,
        avgMs: cost,
        maxMs: cost,
        lastTime: time,
      });
      continue;
    }
    group.count += 1;
    if (entry.failed) group.failed += 1;
    group.totalMs += cost;
    group.maxMs = Math.max(group.maxMs, cost);
    group.avgMs = group.totalMs / group.count;
    if (time > group.lastTime) {
      group.lastTime = time;
      group.sampleSql = sql;
    }
  }

  const sort = filter.sort ?? 'total';
  const metric = (g: SlowQueryGroup): number =>
    sort === 'avg' ? g.avgMs : sort === 'max' ? g.maxMs : sort === 'count' ? g.count : g.totalMs;
  return {
    groups: [...groups.values()]
      .sort((a, b) => metric(b) - metric(a) || b.lastTime - a.lastTime)
      .slice(0, filter.limit ?? DEFAULT_SLOW_QUERY_LIMIT),
    scanned,
  };
}

export function aggregateSlowQueries(
  entries: readonly QueryHistoryEntry[],
  filter: SlowQueryFilter = {},
  now = Date.now(),
  scanOptionsFor?: ScanOptionsResolver,
): SlowQueryGroup[] {
  return aggregateSlowQueriesWithStats(entries, filter, now, scanOptionsFor).groups;
}
