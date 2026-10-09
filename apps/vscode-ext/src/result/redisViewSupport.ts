/**
 * RedisView 支撑模块：与面板实例无关的常量与纯函数。
 *
 * 从 `redisView.ts` 抽出（Phase 2 拆分），供 `redisView` / `redisStreamOps` / `redisCliConsole`
 * 共用，避免这些无状态逻辑占据视图类篇幅。
 */
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { redactCommandArgs } from '@devbelt/db-core';
import type { RedisConnectionSession } from '../connection/connectionSession';
import { l10n } from '../i18n';
import type { RedisDownMessage, RedisPanel, RedisSlowlogEntry } from './protocol';

/**
 * 面板子逻辑（Stream 操作 / CLI 控制台）依赖的最小宿主面。
 * 由 `RedisView` 注入自身实现，使子逻辑与视图状态解耦。
 */
export interface RedisOpsHost {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  sessionForDb(): Promise<RedisConnectionSession>;
  post(msg: RedisDownMessage): void;
  audit(command: string, detail: string, costTime?: number): void;
  doPushValue(session: RedisConnectionSession, key: string): Promise<void>;
  targetDb(): number;
}

/** 大 key 门禁阈值（字节）。 */
export const LARGE_KEY_BYTES = 1024 * 1024;
/** 大 key「强制加载」的硬上限：string 超过只用 GETRANGE 预览，避免宿主内存暴涨。 */
export const FORCE_LOAD_MAX_BYTES = 32 * 1024 * 1024;
/** Stream 单页条目数。 */
export const STREAM_PAGE = 100;
/** hash/set 单页条目数（大集合分页兜底，避免全量 HGETALL/SMEMBERS）。 */
export const HASH_SET_PAGE = 200;

/**
 * H5 最低要求：文本内容含替换符 U+FFFD，说明原始字节不是合法 UTF-8（ioredis 按文本解码有损）。
 * 有损文本回写会破坏二进制数据，故这类键/字段/成员一律只读；完整二进制安全延后。
 */
export function hasReplacement(s: string): boolean {
  return s.includes('\uFFFD');
}

/** 面板对应的 webview viewType。 */
export function redisViewType(panel: RedisPanel): string {
  return `devbelt.redis.${panel}`;
}

/** 面板标题（连接名 + 职责，值面板附 db）。 */
export function redisPanelTitle(panel: RedisPanel, conn: SavedConnection, db?: number): string {
  const base = `Redis @ ${conn.name || conn.host}`;
  switch (panel) {
    case 'keyBrowser': {
      const values = l10n('redis.panel.values');
      return db === undefined ? `${base} · ${values}` : `${base} · ${values} · db${db}`;
    }
    case 'serverStatus': return `${base} · ${l10n('redis.panel.status')}`;
    case 'monitor': return `${base} · ${l10n('redis.panel.monitor')}`;
    case 'console': return `${base} · ${l10n('redis.panel.console')}`;
    case 'slowlog': return `${base} · ${l10n('redis.panel.slowlog')}`;
    case 'commandLog': return `${base} · ${l10n('redis.panel.commandLog')}`;
  }
}

/** 字符串数组归一化。 */
export function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** `[[f,v],…]` 归一化。 */
export function pairsOf(v: unknown): [string, string][] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is unknown[] => Array.isArray(e) && e.length >= 2).map((e) => [String(e[0]), String(e[1])]);
}

/** CLI 中会改变/阻塞共享连接状态的命令（阻止污染其它面板）。 */
export const CLI_BLOCKED_COMMANDS = new Set([
  'RESET', 'QUIT', 'AUTH', 'HELLO', 'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH',
  'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR',
  'BLPOP', 'BRPOP', 'BLMOVE', 'BRPOPLPUSH', 'BZPOPMIN', 'BZPOPMAX', 'BZMPOP', 'BLMPOP',
  // 阻塞/改变共享连接状态或阻塞服务端：
  'WAIT', 'WAITAOF', 'READONLY', 'READWRITE', 'SYNC', 'PSYNC',
]);

export function isCliBlocked(name: string, args: readonly string[]): boolean {
  const c = name.toUpperCase();
  if (CLI_BLOCKED_COMMANDS.has(c)) return true;
  const upper = args.map((a) => a.toUpperCase());
  if (c === 'CLIENT') {
    const sub = upper[0] ?? '';
    if (sub === 'PAUSE' || sub === 'TRACKING') return true;
    // REPLY OFF/SKIP 会让服务端不再回复，共享连接上后续命令会永久挂起。
    if (sub === 'REPLY' && (upper[1] === 'OFF' || upper[1] === 'SKIP')) return true;
  }
  // XREAD/XREADGROUP 带 BLOCK 会阻塞共享连接。
  if ((c === 'XREAD' || c === 'XREADGROUP') && upper.includes('BLOCK')) return true;
  // DEBUG 仅硬阻断会崩溃/阻塞/改状态的子命令；DEBUG OBJECT 等只读子命令放行。
  if (c === 'DEBUG' && ['SEGFAULT', 'PANIC', 'OOM', 'SLEEP', 'CRASH-AND-RECOVER', 'JMAP'].includes(upper[0] ?? '')) return true;
  return false;
}

/** 审计行文本（P7 §十：日志禁止明文密码）。 */
export function redisAuditLine(name: string, args: string[]): string {
  return [name, ...redactCommandArgs(name, args)].join(' ');
}

/** SLOWLOG GET 原始回复 → 归一化条目。 */
export function parseSlowlog(raw: unknown): RedisSlowlogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is unknown[] => Array.isArray(e)).map((e) => ({
    id: Number(e[0] ?? 0),
    timestamp: Number(e[1] ?? 0),
    durationMicros: Number(e[2] ?? 0),
    command: Array.isArray(e[3]) ? e[3].map(String).join(' ') : String(e[3] ?? ''),
    clientAddr: String(e[4] ?? ''),
    clientName: String(e[5] ?? ''),
  }));
}

/** 命令回复 → 可显示文本。 */
export function formatRedisReply(raw: unknown): string {
  if (raw === null || raw === undefined) return '(nil)';
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
}