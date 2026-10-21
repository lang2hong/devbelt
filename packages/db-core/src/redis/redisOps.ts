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

/**
 * 字节级命令源（RedisClient 满足）：返回原始 Buffer，二进制安全。
 * 与 `RedisCommandSource` 分离，使假实现/只读测试源无需实现 buffer 方法。
 */
export interface RedisBufferSource {
  sendCommandBuffer(name: string, args?: (string | number | Buffer)[]): Promise<unknown>;
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
  // 命令名必须小写：ioredis 仅在 `command.name === 'select'` 时记录当前库（Redis.js），
// 大写会在重连时按旧库恢复、离线队列落到错库。
  await src.sendCommand('select', [db]);
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

/**
 * 配置的逻辑库数量（`CONFIG GET databases`），用于键空间之外的 DB 列表来源（空库也能被列出）。
 * 托管环境常禁用 CONFIG（NOPERM/unknown command）：畸形回复或命令失败时降级返回 null，不抛。
 */
export async function redisDatabases(src: RedisCommandSource): Promise<number | null> {
  try {
    const reply = await src.sendCommand('CONFIG', ['GET', 'databases']);
    if (!Array.isArray(reply) || reply.length < 2) return null;
    const n = Number(asString(reply[1]));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ────────────────────────── string ──────────────────────────

export async function redisGet(src: RedisCommandSource, key: string): Promise<string> {
  return asString(await src.sendCommand('GET', [key]));
}

/**
 * 读取 string 值为原始字节（二进制安全）。
 *
 * 优先走 `sendCommandBuffer`（ioredis `replyEncoding:null`）；源不支持时退化为
 * UTF-8 编码（会损失非 UTF-8 字节，仅为兼容假实现/旧源）。
 */
export async function redisGetBuffer(src: RedisCommandSource, key: string): Promise<Buffer | null> {
  if (isBufferSource(src)) {
    const raw = await src.sendCommandBuffer('GET', [key]);
    if (raw === null || raw === undefined) return null;
    if (Buffer.isBuffer(raw)) return raw;
    return Buffer.from(asString(raw), 'utf8');
  }
  const v = await src.sendCommand('GET', [key]);
  return v === null || v === undefined ? null : Buffer.from(asString(v), 'utf8');
}

/** GETRANGE 预览（字节）——大 key 强制加载时只取前 N 字节，避免宿主内存暴涨。 */
export async function redisGetRangeBuffer(src: RedisCommandSource, key: string, start: number, end: number): Promise<Buffer> {
  if (isBufferSource(src)) {
    const raw = await src.sendCommandBuffer('GETRANGE', [key, start, end]);
    if (raw === null || raw === undefined) return Buffer.alloc(0);
    if (Buffer.isBuffer(raw)) return raw;
    return Buffer.from(asString(raw), 'utf8');
  }
  const v = await src.sendCommand('GETRANGE', [key, start, end]);
  return v === null || v === undefined ? Buffer.alloc(0) : Buffer.from(asString(v), 'utf8');
}

export function isBufferSource(src: RedisCommandSource): src is RedisCommandSource & RedisBufferSource {
  return typeof (src as Partial<RedisBufferSource>).sendCommandBuffer === 'function';
}

const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true });

/** 判断字节是否为合法 UTF-8（用于 webview 决定是否提示二进制）。单次解码，无中间 Buffer。 */
export function isValidUtf8(buf: Buffer): boolean {
  try {
    utf8StrictDecoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}

export async function redisStrlen(src: RedisCommandSource, key: string): Promise<number> {
  return asNumber(await src.sendCommand('STRLEN', [key]));
}

export async function redisSet(src: RedisCommandSource, key: string, value: string): Promise<void> {
  await src.sendCommand('SET', [key, value]);
}

/** 字节级写入 string 值（二进制安全）。 */
export async function redisSetBuffer(src: RedisBufferSource, key: string, value: Buffer): Promise<void> {
  await src.sendCommandBuffer('SET', [key, value]);
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

/** HEXISTS：hash field 是否存在（改名防覆盖用）。 */
export async function redisHExists(src: RedisCommandSource, key: string, field: string): Promise<boolean> {
  return asNumber(await src.sendCommand('HEXISTS', [key, field])) === 1;
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

/** LINDEX：按下标取 list 元素（按下标编辑前比对，避免并发错删/错改）。 */
export async function redisLIndex(src: RedisCommandSource, key: string, index: number): Promise<string | null> {
  const v = await src.sendCommand('LINDEX', [key, index]);
  return v === null || v === undefined ? null : String(v);
}

/** ZSCORE：返回 member 的 score；不存在返回 null（member 改名防覆盖用）。 */
export async function redisZScore(src: RedisCommandSource, key: string, member: string): Promise<string | null> {
  const v = await src.sendCommand('ZSCORE', [key, member]);
  return v === null || v === undefined ? null : String(v);
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

/** 集群：逐 master 取完整 INFO（监控面板聚合用）。 */
export async function redisInfoOnNode(node: RedisNodeSource): Promise<string> {
  return asString(await node.call('INFO'));
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

export interface RedisPendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveryCount: number;
}

/** XPENDING 明细：`[[id, consumer, idle, deliveryCount], …]`。 */
export function parseXPendingEntries(reply: unknown): RedisPendingEntry[] {
  if (!Array.isArray(reply)) return [];
  return reply
    .filter((e): e is unknown[] => Array.isArray(e) && e.length >= 4)
    .map((e) => ({
      id: asString(e[0]),
      consumer: asString(e[1]),
      idleMs: asNumber(e[2]),
      deliveryCount: asNumber(e[3]),
    }));
}

export async function redisXPendingEntries(
  src: RedisCommandSource,
  key: string,
  group: string,
  count = 100,
  start = '-',
  end = '+',
  consumer?: string,
): Promise<RedisPendingEntry[]> {
  const args: (string | number)[] = [key, group, start, end, count];
  if (consumer) args.push(consumer);
  return parseXPendingEntries(await src.sendCommand('XPENDING', args));
}

/** XACK：确认 pending 条目；返回实际确认数量。 */
export async function redisXAck(src: RedisCommandSource, key: string, group: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  return asNumber(await src.sendCommand('XACK', [key, group, ...ids]));
}

/** XCLAIM JUSTID：把 selected pending 条目转交给目标 consumer（不自动 ack）。 */
export async function redisXClaim(src: RedisCommandSource, key: string, group: string, consumer: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const reply = await src.sendCommand('XCLAIM', [key, group, consumer, 0, ...ids, 'JUSTID']);
  return Array.isArray(reply) ? reply.map(asString) : [];
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

// ────────────────────────── 字节级集合 ops（Stage B / 3C-1） ──────────────────────────
// 二进制安全：经 `sendCommandBuffer`（ioredis replyEncoding:null）读取原始字节；
// 源不支持 buffer 命令时降级为字符串结果转 UTF-8 Buffer（有损但行为可用，与 redisGetBuffer 同口径）。

/** 字节级命令源判定后，把任意回复元素归一为 Buffer。 */
function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v === null || v === undefined) return Buffer.alloc(0);
  return Buffer.from(String(v), 'utf8');
}

/** `[f1,v1,f2,v2,…]`（元素 Buffer/字符串）两两成对；已是 `[[k,v],…]` 原样归一。 */
function toBufferPairs(reply: unknown): [Buffer, Buffer][] {
  if (!Array.isArray(reply)) return [];
  if (reply.length && Array.isArray(reply[0])) {
    return (reply as unknown[][]).map((p) => [toBuffer(p[0]), toBuffer(p[1])]);
  }
  const out: [Buffer, Buffer][] = [];
  for (let i = 0; i + 1 < reply.length; i += 2) out.push([toBuffer(reply[i]), toBuffer(reply[i + 1])]);
  return out;
}

function bufferScanArgs(key: string, cursor: string | number, opts: RedisScanOptions): (string | number)[] {
  const args: (string | number)[] = [key, String(cursor)];
  if (opts.match) args.push('MATCH', opts.match);
  if (opts.count) args.push('COUNT', opts.count);
  return args;
}

/** 字节级 HSCAN（cursor 为文本；field/value 为原始字节）。 */
export async function redisHScanBuffer(src: RedisCommandSource, key: string, cursor: string | number, opts: RedisScanOptions = {}): Promise<{ cursor: string; entries: [Buffer, Buffer][] }> {
  if (isBufferSource(src)) {
    const reply = await src.sendCommandBuffer('HSCAN', bufferScanArgs(key, cursor, opts));
    if (!Array.isArray(reply)) return { cursor: '0', entries: [] };
    return { cursor: asString(reply[0]), entries: toBufferPairs(reply[1]) };
  }
  const page = await redisHScan(src, key, cursor, opts);
  return { cursor: page.cursor, entries: page.entries.map(([f, v]) => [Buffer.from(f, 'utf8'), Buffer.from(v, 'utf8')]) };
}

/** 字节级 SSCAN（cursor 为文本；members 为原始字节）。 */
export async function redisSScanBuffer(src: RedisCommandSource, key: string, cursor: string | number, opts: RedisScanOptions = {}): Promise<{ cursor: string; keys: Buffer[] }> {
  if (isBufferSource(src)) {
    const reply = await src.sendCommandBuffer('SSCAN', bufferScanArgs(key, cursor, opts));
    if (!Array.isArray(reply)) return { cursor: '0', keys: [] };
    const raw = Array.isArray(reply[1]) ? (reply[1] as unknown[]) : [];
    return { cursor: asString(reply[0]), keys: raw.map(toBuffer) };
  }
  const page = await redisSScan(src, key, cursor, opts);
  return { cursor: page.cursor, keys: page.keys.map((k) => Buffer.from(k, 'utf8')) };
}

/** 字节级 LRANGE。 */
export async function redisLRangeBuffer(src: RedisCommandSource, key: string, start: number, stop: number): Promise<Buffer[]> {
  if (isBufferSource(src)) {
    const reply = await src.sendCommandBuffer('LRANGE', [key, start, stop]);
    return Array.isArray(reply) ? reply.map(toBuffer) : [];
  }
  return (await redisLRange(src, key, start, stop)).map((v) => Buffer.from(v, 'utf8'));
}

/** 字节级 ZRANGE（WITHSCORES；member 为原始字节，score 为文本）。 */
export async function redisZRangeBuffer(src: RedisCommandSource, key: string, start: number, stop: number, opts: { rev?: boolean } = {}): Promise<{ member: Buffer; score: string }[]> {
  if (isBufferSource(src)) {
    const args: (string | number)[] = [key, start, stop];
    if (opts.rev) args.push('REV');
    args.push('WITHSCORES');
    const reply = await src.sendCommandBuffer('ZRANGE', args);
    if (!Array.isArray(reply)) return [];
    // 兼容 `[[member,score],…]`（测试/降级形态）与扁平的 `[member,score,…]`（ioredis WITHSCORES）。
    if (reply.length && Array.isArray(reply[0])) {
      return (reply as unknown[][]).map((p) => ({ member: toBuffer(p[0]), score: asString(p[1]) }));
    }
    const out: { member: Buffer; score: string }[] = [];
    for (let i = 0; i + 1 < reply.length; i += 2) out.push({ member: toBuffer(reply[i]), score: asString(reply[i + 1]) });
    return out;
  }
  const pairs = await redisZRange(src, key, start, stop, { rev: opts.rev });
  return pairs.map(([m, s]) => ({ member: Buffer.from(m, 'utf8'), score: s }));
}

/** 字节级 LINDEX（不存在返回 null）。 */
export async function redisLIndexBuffer(src: RedisCommandSource, key: string, index: number): Promise<Buffer | null> {
  if (isBufferSource(src)) {
    const raw = await src.sendCommandBuffer('LINDEX', [key, index]);
    return raw === null || raw === undefined ? null : toBuffer(raw);
  }
  const v = await redisLIndex(src, key, index);
  return v === null ? null : Buffer.from(v, 'utf8');
}

/** 字节级 LSET（二进制值回写/回滚用）。 */
export async function redisLSetBuffer(src: RedisCommandSource, key: string, index: number, value: Buffer): Promise<void> {
  if (isBufferSource(src)) {
    await src.sendCommandBuffer('LSET', [key, index, value]);
    return;
  }
  await redisLSet(src, key, index, value.toString('utf8'));
}

/** 字节级 XRANGE 条目。 */
export interface RedisStreamBufferEntry {
  id: string;
  fields: [Buffer, Buffer][];
}

/** 字节级 XRANGE（field/value 为原始字节）。 */
export async function redisXRangeBuffer(src: RedisCommandSource, key: string, start = '-', end = '+', count?: number): Promise<RedisStreamBufferEntry[]> {
  if (isBufferSource(src)) {
    const args: (string | number)[] = [key, start, end];
    if (count) args.push('COUNT', count);
    const reply = await src.sendCommandBuffer('XRANGE', args);
    if (!Array.isArray(reply)) return [];
    return (reply as unknown[][])
      .filter((e): e is unknown[] => Array.isArray(e) && e.length >= 2)
      .map((e) => ({ id: asString(e[0]), fields: toBufferPairs(e[1]) }));
  }
  const entries = await redisXRange(src, key, start, end, count);
  return entries.map((e) => ({
    id: e.id,
    fields: e.fields.map(([f, v]) => [Buffer.from(f, 'utf8'), Buffer.from(v, 'utf8')] as [Buffer, Buffer]),
  }));
}

/** 字节级删除：HDEL / SREM / ZREM（字段/成员按原始字节命中）。 */
export async function redisHDelBuffer(src: RedisCommandSource, key: string, fields: Buffer[]): Promise<number> {
  if (!fields.length) return 0;
  if (isBufferSource(src)) return asNumber(await src.sendCommandBuffer('HDEL', [key, ...fields]));
  return redisHDel(src, key, fields.map((b) => b.toString('utf8')));
}

export async function redisSRemBuffer(src: RedisCommandSource, key: string, members: Buffer[]): Promise<number> {
  if (!members.length) return 0;
  if (isBufferSource(src)) return asNumber(await src.sendCommandBuffer('SREM', [key, ...members]));
  return redisSRem(src, key, members.map((b) => b.toString('utf8')));
}

export async function redisZRemBuffer(src: RedisCommandSource, key: string, members: Buffer[]): Promise<number> {
  if (!members.length) return 0;
  if (isBufferSource(src)) return asNumber(await src.sendCommandBuffer('ZREM', [key, ...members]));
  return redisZRem(src, key, members.map((b) => b.toString('utf8')));
}

export async function redisLRemBuffer(src: RedisCommandSource, key: string, count: number, value: Buffer): Promise<number> {
  if (isBufferSource(src)) return asNumber(await src.sendCommandBuffer('LREM', [key, count, value]));
  return redisLRem(src, key, count, value.toString('utf8'));
}

/** 字节级 HSET（field/value 均原始字节）。 */
export async function redisHSetBuffer(src: RedisCommandSource, key: string, field: Buffer, value: Buffer): Promise<void> {
  if (isBufferSource(src)) {
    await src.sendCommandBuffer('HSET', [key, field, value]);
    return;
  }
  await redisHSet(src, key, field.toString('utf8'), value.toString('utf8'));
}

/** 字节级 ZADD（member 原始字节；score 文本）。 */
export async function redisZAddBuffer(src: RedisCommandSource, key: string, score: string | number, member: Buffer): Promise<void> {
  if (isBufferSource(src)) {
    await src.sendCommandBuffer('ZADD', [key, String(score), member]);
    return;
  }
  await redisZAdd(src, key, score, member.toString('utf8'));
}
