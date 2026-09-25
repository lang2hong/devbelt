/**
 * Redis 高层操作（P7 S3）。
 *
 * 对 `sendCommand` 之上的类型化封装：SCAN/DB/TTL 与五种基础类型的读写。
 * 纯函数 + 最小依赖接口，便于单测注入假实现；不改变只读切面（写命令仍由
 * RedisClient.sendCommand 切面统一拦截）。
 *
 * 与 P7 文档 §6.2 的措辞差异：这些方法放独立 ops 模块而非挂到 RedisClient 上，
 * 保持 RedisClient 聚焦连接/切面/日志。
 */

/** redisOps 依赖的最小命令源（RedisClient 满足）。 */
export interface RedisCommandSource {
  sendCommand(name: string, args?: (string | number)[]): Promise<unknown>;
}

/** 集群节点执行单元（ioredis Cluster 的各 master）。 */
export interface RedisNodeSource {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisScanResult {
  cursor: string;
  keys: string[];
}

export interface RedisDbStat {
  index: number;
  keys: number;
  expires: number;
  avgTtl: number;
}

export interface RedisScanOptions {
  match?: string;
  count?: number;
}

function asString(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asString) : [];
}

function asNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 把 `[a,b,c,d]` 两两成对；已是 `[[k,v],...]` 则原样归一化。 */
function toPairs(reply: unknown): [string, string][] {
  if (!Array.isArray(reply)) return [];
  if (reply.length && Array.isArray(reply[0])) {
    return (reply as unknown[][]).map((p) => [asString(p[0]), asString(p[1])] as [string, string]);
  }
  const flat = reply.map(asString);
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/** HGETALL 回复归一化：兼容扁平行数组 / `[[k,v]]` / 对象三种形态。 */
export function normalizeHashReply(reply: unknown): [string, string][] {
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    return Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, asString(v)] as [string, string]);
  }
  return toPairs(reply);
}

// ────────────────────────── 通用 / DB ──────────────────────────

export async function redisType(src: RedisCommandSource, key: string): Promise<string> {
  return asString(await src.sendCommand('TYPE', [key])).toLowerCase();
}

export async function redisScan(src: RedisCommandSource, cursor: string | number, opts: RedisScanOptions = {}): Promise<RedisScanResult> {
  const args: (string | number)[] = [String(cursor)];
  if (opts.match) args.push('MATCH', opts.match);
  if (opts.count) args.push('COUNT', opts.count);
  const reply = await src.sendCommand('SCAN', args);
  if (!Array.isArray(reply)) return { cursor: '0', keys: [] };
  return { cursor: asString(reply[0]), keys: asStringArray(reply[1]) };
}

export async function redisExists(src: RedisCommandSource, key: string): Promise<boolean> {
  return asNumber(await src.sendCommand('EXISTS', [key])) > 0;
}

export async function redisDbsize(src: RedisCommandSource): Promise<number> {
  return asNumber(await src.sendCommand('DBSIZE'));
}

export async function redisSelect(src: RedisCommandSource, db: number): Promise<void> {
  await src.sendCommand('SELECT', [db]);
}

/** 解析 `INFO keyspace` 为 DB 列表。 */
export function parseKeyspace(info: string): RedisDbStat[] {
  const out: RedisDbStat[] = [];
  const re = /^db(\d+):keys=(\d+)(?:,expires=(\d+))?(?:,avg_ttl=(\d+))?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(info)) !== null) {
    out.push({
      index: Number(m[1]),
      keys: Number(m[2]),
      expires: m[3] ? Number(m[3]) : 0,
      avgTtl: m[4] ? Number(m[4]) : 0,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

export async function redisKeyspace(src: RedisCommandSource): Promise<RedisDbStat[]> {
  return parseKeyspace(await src.sendCommand('INFO', ['keyspace']).then(asString));
}

// ────────────────────────── string ──────────────────────────

export async function redisGet(src: RedisCommandSource, key: string): Promise<string> {
  return asString(await src.sendCommand('GET', [key]));
}

export async function redisStrlen(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('STRLEN', [key]));
}

export async function redisSet(src: RedisCommandSource, key: string, value: string): Promise<void> {
  await src.sendCommand('SET', [key, value]);
}

export async function redisAppend(src: RedisCommandSource, key: string, value: string): Promise<number> {
  return asNumber(await src.sendCommand('APPEND', [key, value]));
}

export async function redisDel(src: RedisCommandSource, keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  return asNumber(await src.sendCommand('DEL', keys));
}

export async function redisUnlink(src: RedisCommandSource, keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  return asNumber(await src.sendCommand('UNLINK', keys));
}

export async function redisRename(src: RedisCommandSource, key: string, newKey: string): Promise<void> {
  await src.sendCommand('RENAME', [key, newKey]);
}

/** TTL（秒）：-1 永久，-2 不存在。 */
export async function redisTtl(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('TTL', [key]));
}

/** PTTL（毫秒）：-1 永久，-2 不存在。 */
export async function redisPttl(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('PTTL', [key]));
}

export async function redisExpire(src: RedisCommandSource, key: string, seconds: number): Promise<boolean> {
  return asNumber(await src.sendCommand('EXPIRE', [key, seconds])) === 1;
}

export async function redisPersist(src: RedisCommandSource, key: string): Promise<boolean> {
  return asNumber(await src.sendCommand('PERSIST', [key])) === 1;
}

/** MEMORY USAGE（字节）；不可用/被禁用时返回 null（不门禁）。 */
export async function redisMemoryUsage(src: RedisCommandSource, key: string): Promise<number | null> {
  try {
    const v = await src.sendCommand('MEMORY', ['USAGE', key]);
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ────────────────────────── hash ──────────────────────────

export async function redisHGetAll(src: RedisCommandSource, key: string): Promise<[string, string][]> {
  return normalizeHashReply(await src.sendCommand('HGETALL', [key]));
}

export async function redisHScan(src: RedisCommandSource, key: string, cursor: string | number, opts: RedisScanOptions = {}): Promise<{ cursor: string; entries: [string, string][] }> {
  const args: (string | number)[] = [key, String(cursor)];
  if (opts.match) args.push('MATCH', opts.match);
  if (opts.count) args.push('COUNT', opts.count);
  const reply = await src.sendCommand('HSCAN', args);
  if (!Array.isArray(reply)) return { cursor: '0', entries: [] };
  return { cursor: asString(reply[0]), entries: toPairs(reply[1]) };
}

export async function redisHSet(src: RedisCommandSource, key: string, field: string, value: string): Promise<void> {
  await src.sendCommand('HSET', [key, field, value]);
}

export async function redisHDel(src: RedisCommandSource, key: string, fields: string[]): Promise<number> {
  if (!fields.length) return 0;
  return asNumber(await src.sendCommand('HDEL', [key, ...fields]));
}

export async function redisHLen(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('HLEN', [key]));
}

// ────────────────────────── list ──────────────────────────

export async function redisLRange(src: RedisCommandSource, key: string, start: number, stop: number): Promise<string[]> {
  return asStringArray(await src.sendCommand('LRANGE', [key, start, stop]));
}

export async function redisLLen(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('LLEN', [key]));
}

export async function redisLPush(src: RedisCommandSource, key: string, values: string[]): Promise<number> {
  return asNumber(await src.sendCommand('LPUSH', [key, ...values]));
}

export async function redisRPush(src: RedisCommandSource, key: string, values: string[]): Promise<number> {
  return asNumber(await src.sendCommand('RPUSH', [key, ...values]));
}

export async function redisLSet(src: RedisCommandSource, key: string, index: number, value: string): Promise<void> {
  await src.sendCommand('LSET', [key, index, value]);
}

export async function redisLRem(src: RedisCommandSource, key: string, count: number, value: string): Promise<number> {
  return asNumber(await src.sendCommand('LREM', [key, count, value]));
}

export async function redisLTrim(src: RedisCommandSource, key: string, start: number, stop: number): Promise<void> {
  await src.sendCommand('LTRIM', [key, start, stop]);
}

export async function redisLPop(src: RedisCommandSource, key: string): Promise<string | null> {
  const v = await src.sendCommand('LPOP', [key]);
  return v === null || v === undefined ? null : asString(v);
}

export async function redisRPop(src: RedisCommandSource, key: string): Promise<string | null> {
  const v = await src.sendCommand('RPOP', [key]);
  return v === null || v === undefined ? null : asString(v);
}

// ────────────────────────── set ──────────────────────────

export async function redisSMembers(src: RedisCommandSource, key: string): Promise<string[]> {
  return asStringArray(await src.sendCommand('SMEMBERS', [key]));
}

export async function redisSScan(src: RedisCommandSource, key: string, cursor: string | number, opts: RedisScanOptions = {}): Promise<RedisScanResult> {
  const args: (string | number)[] = [key, String(cursor)];
  if (opts.match) args.push('MATCH', opts.match);
  if (opts.count) args.push('COUNT', opts.count);
  const reply = await src.sendCommand('SSCAN', args);
  if (!Array.isArray(reply)) return { cursor: '0', keys: [] };
  return { cursor: asString(reply[0]), keys: asStringArray(reply[1]) };
}

export async function redisSCard(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('SCARD', [key]));
}

export async function redisSAdd(src: RedisCommandSource, key: string, members: string[]): Promise<number> {
  return asNumber(await src.sendCommand('SADD', [key, ...members]));
}

export async function redisSRem(src: RedisCommandSource, key: string, members: string[]): Promise<number> {
  return asNumber(await src.sendCommand('SREM', [key, ...members]));
}

// ────────────────────────── zset ──────────────────────────

export async function redisZRange(src: RedisCommandSource, key: string, start: number, stop: number, opts: { rev?: boolean; withScores?: boolean } = {}): Promise<[string, string][]> {
  const args: (string | number)[] = [key, start, stop];
  if (opts.rev) args.push('REV');
  if (opts.withScores !== false) args.push('WITHSCORES');
  return toPairs(await src.sendCommand('ZRANGE', args));
}

export async function redisZRangeByScore(src: RedisCommandSource, key: string, min: string | number, max: string | number, opts: { rev?: boolean; withScores?: boolean } = {}): Promise<[string, string][]> {
  const cmd = opts.rev ? 'ZREVRANGEBYSCORE' : 'ZRANGEBYSCORE';
  const args: (string | number)[] = opts.rev ? [key, max, min] : [key, min, max];
  if (opts.withScores !== false) args.push('WITHSCORES');
  return toPairs(await src.sendCommand(cmd, args));
}

export async function redisZCard(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('ZCARD', [key]));
}

export async function redisZAdd(src: RedisCommandSource, key: string, score: string | number, member: string): Promise<void> {
  await src.sendCommand('ZADD', [key, String(score), member]);
}

export async function redisZRem(src: RedisCommandSource, key: string, members: string[]): Promise<number> {
  return asNumber(await src.sendCommand('ZREM', [key, ...members]));
}

export async function redisZIncrBy(src: RedisCommandSource, key: string, increment: string | number, member: string): Promise<string> {
  return asString(await src.sendCommand('ZINCRBY', [key, String(increment), member]));
}

// ────────────────────────── 集群：按节点 ops（S4） ──────────────────────────
// Cluster 无 SELECT，且 SCAN/INFO/SLOWLOG/DBSIZE 需逐 master 执行、主机侧合并游标。

export async function redisScanOnNode(node: RedisNodeSource, cursor: string | number, opts: RedisScanOptions = {}): Promise<RedisScanResult> {
  const args: (string | number)[] = [String(cursor)];
  if (opts.match) args.push('MATCH', opts.match);
  if (opts.count) args.push('COUNT', opts.count);
  const reply = await node.call('SCAN', ...args);
  if (!Array.isArray(reply)) return { cursor: '0', keys: [] };
  return { cursor: asString(reply[0]), keys: asStringArray(reply[1]) };
}

export async function redisKeyspaceOnNode(node: RedisNodeSource): Promise<RedisDbStat[]> {
  return parseKeyspace(asString(await node.call('INFO', 'keyspace')));
}

export async function redisDbsizeOnNode(node: RedisNodeSource): Promise<number> {
  return asNumber(await node.call('DBSIZE'));
}

export async function redisSlowlogOnNode(node: RedisNodeSource, count = 128): Promise<unknown> {
  return node.call('SLOWLOG', 'GET', count);
}

// ────────────────────────── Stream（S4） ──────────────────────────

export interface RedisStreamEntry {
  id: string;
  fields: [string, string][];
}

/** XRANGE/XREVRANGE 回复归一化：`[[id,[f,v,...]],…]` → `{id, fields}`。 */
export function parseStreamEntries(reply: unknown): RedisStreamEntry[] {
  if (!Array.isArray(reply)) return [];
  return reply
    .filter((e): e is unknown[] => Array.isArray(e) && e.length >= 2)
    .map((e) => ({ id: asString(e[0]), fields: toPairs(e[1]) }));
}

export async function redisXRange(src: RedisCommandSource, key: string, start = '-', end = '+', count?: number): Promise<RedisStreamEntry[]> {
  const args: (string | number)[] = [key, start, end];
  if (count) args.push('COUNT', count);
  return parseStreamEntries(await src.sendCommand('XRANGE', args));
}

export async function redisXRevRange(src: RedisCommandSource, key: string, end = '+', start = '-', count?: number): Promise<RedisStreamEntry[]> {
  const args: (string | number)[] = [key, end, start];
  if (count) args.push('COUNT', count);
  return parseStreamEntries(await src.sendCommand('XREVRANGE', args));
}

export async function redisXAdd(src: RedisCommandSource, key: string, fields: [string, string][], id = '*'): Promise<string> {
  const args: (string | number)[] = [key, id];
  for (const [f, v] of fields) args.push(f, v);
  return asString(await src.sendCommand('XADD', args));
}

export async function redisXDel(src: RedisCommandSource, key: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  return asNumber(await src.sendCommand('XDEL', [key, ...ids]));
}

export async function redisXTrimMaxlen(src: RedisCommandSource, key: string, maxlen: number): Promise<number> {
  return asNumber(await src.sendCommand('XTRIM', [key, 'MAXLEN', maxlen]));
}

export async function redisXLen(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('XLEN', [key]));
}

/** XINFO 类的扁平 [k,v,…] 回复 → 对象数组。 */
export function parseInfoEntries(reply: unknown): Record<string, string>[] {
  if (!Array.isArray(reply)) return [];
  return reply
    .filter((e): e is unknown[] => Array.isArray(e))
    .map((e) => Object.fromEntries(toPairs(e)));
}

export async function redisXInfoGroups(src: RedisCommandSource, key: string): Promise<Record<string, string>[]> {
  return parseInfoEntries(await src.sendCommand('XINFO', ['GROUPS', key]));
}

export async function redisXInfoConsumers(src: RedisCommandSource, key: string, group: string): Promise<Record<string, string>[]> {
  return parseInfoEntries(await src.sendCommand('XINFO', ['CONSUMERS', key, group]));
}

export async function redisXGroupCreate(src: RedisCommandSource, key: string, group: string, id = '$', mkstream = true): Promise<void> {
  const args: (string | number)[] = [key, group, id];
  if (mkstream) args.push('MKSTREAM');
  await src.sendCommand('XGROUP', ['CREATE', ...args]);
}

export async function redisXGroupDestroy(src: RedisCommandSource, key: string, group: string): Promise<number> {
  return asNumber(await src.sendCommand('XGROUP', ['DESTROY', key, group]));
}

export async function redisXGroupDelConsumer(src: RedisCommandSource, key: string, group: string, consumer: string): Promise<number> {
  return asNumber(await src.sendCommand('XGROUP', ['DELCONSUMER', key, group, consumer]));
}

export interface RedisPendingSummary {
  count: number;
  minId: string;
  maxId: string;
  consumers: [string, string][];
}

/** XPENDING key group 摘要回复归一化：`[count, minId, maxId, [[consumer,count],…]]`。 */
export function parseXPending(reply: unknown): RedisPendingSummary {
  const empty: RedisPendingSummary = { count: 0, minId: '', maxId: '', consumers: [] };
  if (!Array.isArray(reply) || reply.length < 4) return empty;
  return {
    count: asNumber(reply[0]),
    minId: asString(reply[1]),
    maxId: asString(reply[2]),
    consumers: toPairs(reply[3]),
  };
}

export async function redisXPending(src: RedisCommandSource, key: string, group: string): Promise<RedisPendingSummary> {
  return parseXPending(await src.sendCommand('XPENDING', [key, group]));
}

/** 自填 XADD ID 合法性：`*` 或 `<ms>[-<seq>]`（纯数字）。 */
export function isValidStreamId(id: string): boolean {
  return id === '*' || /^\d+(-\d+)?$/.test(id);
}

function splitStreamId(id: string): [number, number] {
  const [ms, seq] = id.split('-');
  return [Number(ms) || 0, Number(seq) || 0];
}

/** 比较两个 stream ID 的先后（-1/0/1）；缺 seq 视为 0。 */
export function compareStreamId(a: string, b: string): number {
  const [am, as] = splitStreamId(a);
  const [bm, bs] = splitStreamId(b);
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}
