/**
 * Redis 命令表与命令分类。
 *
 * 移植自 Another Redis Desktop Manager (ARDM) v1.1.1 的 src/commands.js
 *   https://github.com/qishibo/AnotherRedisDesktopManager
 *   Copyright (c) shibo — MIT License（保留归属）。
 *
 * DevBelt 相对上游的有意差异（见 P7 设计文档 §6.2/§6.6）：
 *   1. 上游把 BITOP（会写 destkey）放在 readCMD；这里移入 writeCMD，避免只读模式放行 BITOP。
 *   2. 上游只读模式仅查 writeCMD，漏掉一批 admin 写命令；这里补 ADMIN_WRITE_* denylist。
 *   3. 上游 readCMD/adminCMD 为模块内私有常量；这里全部导出，供补全/只读/危险判定复用。
 */

/** 单条命令模板：字符串或字符串数组（同一命令的多个子命令模板）。 */
export type RedisCommandSpec = string | string[];

export const adminCMD: Record<string, RedisCommandSpec> = {
  ACL: ['ACL CAT [categoryname]', 'ACL DELUSER username [username ...]', 'ACL DRYRUN username command [arg [arg ...]]', 'ACL GENPASS [bits]', 'ACL GETUSER username', 'ACL LIST', 'ACL LOAD', 'ACL LOG [count|RESET]', 'ACL SAVE', 'ACL SETUSER username [rule [rule ...]]', 'ACL USERS', 'ACL WHOAMI'],
  BGREWRITEAOF: 'BGREWRITEAOF',
  BGSAVE: 'BGSAVE',
  CLIENT: ['CLIENT LIST [TYPE normal|master|replica|pubsub]', 'CLIENT GETNAME', 'CLIENT REPLY ON|OFF|SKIP', 'CLIENT ID'],
  CLUSTER: ['CLUSTER COUNT-FAILURE-REPORTS node-id', 'CLUSTER COUNTKEYSINSLOT slot', 'CLUSTER GETKEYSINSLOT slot count', 'CLUSTER INFO', 'CLUSTER KEYSLOT key', 'CLUSTER NODES', 'CLUSTER SLAVES node-id', 'CLUSTER REPLICAS node-id', 'CLUSTER SLOTS'],
  CONFIG: ['CONFIG GET parameter', 'CONFIG SET parameter value', 'CONFIG RESETSTAT'],
  DEBUG: ['DEBUG OBJECT key', 'DEBUG SEGFAULT'],
  FAILOVER: 'FAILOVER [TO host port [FORCE]] [ABORT] [TIMEOUT milliseconds]',
  LATENCY: ['LATENCY DOCTOR', 'LATENCY GRAPH event', 'LATENCY HISTOGRAM [command [command ...]]', 'LATENCY HISTORY event', 'LATENCY LATEST', 'LATENCY RESET [event [event ...]]'],
  MODULE: ['MODULE LIST', 'MODULE LOAD path [arg [arg ...]]', 'MODULE UNLOAD name'],
  MONITOR: 'MONITOR',
  PFDEBUG: 'PFDEBUG',
  PFSELFTEST: 'PFSELFTEST',
  PSYNC: 'PSYNC replicationid offset',
  REPLCONF: 'REPLCONF',
  REPLICAOF: 'REPLICAOF host port',
  SAVE: 'SAVE',
  SHUTDOWN: 'SHUTDOWN [NOSAVE|SAVE] [NOW] [FORCE] [ABORT]',
  SLAVEOF: 'SLAVEOF host port',
  SLOWLOG: 'SLOWLOG subcommand [argument]',
  SYNC: 'SYNC',
};

export const readCMD: Record<string, RedisCommandSpec> = {
  AUTH: 'AUTH password',
  ARCOUNT: 'ARCOUNT key',
  ARGREP: 'ARGREP key start end <EXACT string | MATCH string | GLOB pattern | RE pattern> [AND|OR|LIMIT limit|WITHVALUES|NOCASE]',
  ARGET: 'ARGET key index',
  ARGETRANGE: 'ARGETRANGE key start end',
  ARINFO: 'ARINFO key [FULL]',
  ARLASTITEMS: 'ARLASTITEMS key count',
  ARLEN: 'ARLEN key',
  ARNEXT: 'ARNEXT key',
  ARSCAN: 'ARSCAN key start end [LIMIT limit]',
  BITCOUNT: 'BITCOUNT key [start] [end]',
  BITPOS: 'BITPOS key bit [start] [end]',
  COMMAND: ['COMMAND COUNT', 'COMMAND GETKEYS', 'COMMAND INFO command-name [command-name ...]'],
  DBSIZE: 'DBSIZE',
  DISCARD: 'DISCARD',
  DUMP: 'DUMP key',
  ECHO: 'ECHO message',
  EXEC: 'EXEC',
  EXISTS: 'EXISTS key',
  GET: 'GET key',
  GETBIT: 'GETBIT key offset',
  GETRANGE: 'GETRANGE key start end',
  HEXISTS: 'HEXISTS key field',
  HGET: 'HGET key field',
  HGETALL: 'HGETALL key',
  HKEYS: 'HKEYS key',
  HLEN: 'HLEN key',
  HMGET: 'HMGET key field [field ...]',
  HSCAN: 'HSCAN key cursor [MATCH pattern] [COUNT count]',
  HVALS: 'HVALS key',
  INFO: 'INFO [section]',
  KEYS: 'KEYS pattern',
  LASTSAVE: 'LASTSAVE',
  LINDEX: 'LINDEX key index',
  LLEN: 'LLEN key',
  LRANGE: 'LRANGE key start stop',
  MGET: 'MGET key [key ...]',
  MULTI: 'MULTI',
  OBJECT: ['OBJECT ENCODING key', 'OBJECT FREQ key', 'OBJECT IDLETIME key', 'OBJECT REFCOUNT key'],
  PING: 'PING [message]',
  PUBSUB: ['PUBSUB CHANNELS [pattern]', 'PUBSUB NUMSUB [channel-1 ...]', 'PUBSUB NUMPAT'],
  PSUBSCRIBE: 'PSUBSCRIBE pattern [pattern ...]',
  PTTL: 'PTTL key',
  PUNSUBSCRIBE: 'PUNSUBSCRIBE [pattern ...]',
  RANDOMKEY: 'RANDOMKEY',
  ROLE: 'ROLE',
  SCAN: 'SCAN cursor [MATCH pattern] [COUNT count]',
  SCARD: 'SCARD key',
  SDIFF: 'SDIFF key [key ...]',
  SELECT: 'SELECT index',
  SINTER: 'SINTER key [key ...]',
  SISMEMBER: 'SISMEMBER key member',
  SMEMBERS: 'SMEMBERS key',
  SRANDMEMBER: 'SRANDMEMBER key [count]',
  SSCAN: 'SSCAN key cursor [MATCH pattern] [COUNT count]',
  STRLEN: 'STRLEN key',
  SUBSCRIBE: 'SUBSCRIBE channel [channel ...]',
  SUNION: 'SUNION key [key ...]',
  TIME: 'TIME',
  TTL: 'TTL key',
  TYPE: 'TYPE key',
  UNSUBSCRIBE: 'UNSUBSCRIBE [channel ...]',
  UNWATCH: 'UNWATCH',
  WATCH: 'WATCH key [key ...]',
  ZCARD: 'ZCARD key',
  ZCOUNT: 'ZCOUNT key min max',
  ZLEXCOUNT: 'ZLEXCOUNT key min max',
  ZRANGE: 'ZRANGE key start stop [WITHSCORES]',
  ZRANGEBYLEX: 'ZRANGEBYLEX key min max [LIMIT offset count]',
  ZRANGEBYSCORE: 'ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]',
  ZRANK: 'ZRANK key member',
  ZREVRANGE: 'ZREVRANGE key start stop [WITHSCORES]',
  ZREVRANGEBYLEX: 'ZREVRANGEBYLEX key max min [LIMIT offset count]',
  ZREVRANGEBYSCORE: 'ZREVRANGEBYSCORE key max min [WITHSCORES] [LIMIT offset count]',
  ZREVRANK: 'ZREVRANK key member',
  ZSCAN: 'ZSCAN key cursor [MATCH pattern] [COUNT count]',
  ZSCORE: 'ZSCORE key member',
  // fail-closed 下补全的常见只读命令（否则只读连接会误拦）。
  QUIT: 'QUIT',
  SUBSTR: 'SUBSTR key start end',
  LCS: 'LCS key1 key2 [LEN] [IDX] [MINMATCHLEN len] [WITHMATCHLEN]',
  EXPIRETIME: 'EXPIRETIME key',
  PEXPIRETIME: 'PEXPIRETIME key',
  HRANDFIELD: 'HRANDFIELD key [count [WITHVALUES]]',
  LPOS: 'LPOS key element [RANK rank] [COUNT num-matches] [MAXLEN len]',
  SINTERCARD: 'SINTERCARD numkeys key [key ...] [LIMIT limit]',
  SMISMEMBER: 'SMISMEMBER key member [member ...]',
  ZMSCORE: 'ZMSCORE key member [member ...]',
  ZRANDMEMBER: 'ZRANDMEMBER key [count [WITHSCORES]]',
  GEOSEARCH: 'GEOSEARCH key <FROMMEMBER member | FROMLONLAT longitude latitude> <BYRADIUS radius unit | BYBOX width height unit> [ASC|DESC] [COUNT count [ANY]] [WITHCOORD] [WITHDIST] [WITHHASH]',
  SORT_RO: 'SORT_RO key [BY pattern] [LIMIT offset count] [GET pattern [GET pattern ...]] [ASC|DESC] [ALPHA]',
  EVAL_RO: 'EVAL_RO script numkeys key [key ...] arg [arg ...]',
  EVALSHA_RO: 'EVALSHA_RO sha1 numkeys key [key ...] arg [arg ...]',
  FCALL_RO: 'FCALL_RO function numkeys key [key ...] arg [arg ...]',
  GEOHASH: 'GEOHASH key member [member ...]',
  GEOPOS: 'GEOPOS key member [member ...]',
  GEODIST: 'GEODIST key member1 member2 [unit]',
  HSTRLEN: 'HSTRLEN key field',
  MEMORY: ['MEMORY DOCTOR', 'MEMORY HELP', 'MEMORY MALLOC-STATS', 'MEMORY STATS', 'MEMORY USAGE key [SAMPLES count]'],
  XINFO: 'XINFO [CONSUMERS key groupname] [GROUPS key] [STREAM key] [HELP]',
  XRANGE: 'XRANGE key start end [COUNT count]',
  XREVRANGE: 'XREVRANGE key end start [COUNT count]',
  XLEN: 'XLEN key',
  XREAD: 'XREAD [COUNT count] [BLOCK milliseconds] STREAMS key [key ...] ID [ID ...]',
  XPENDING: 'XPENDING key group [start end count] [consumer]',
  VCARD: 'VCARD key',
  VDIM: 'VDIM key',
  VEMB: 'VEMB key element [RAW]',
  VGETATTR: 'VGETATTR key element',
  VINFO: 'VINFO key',
  VISMEMBER: 'VISMEMBER key element',
  VLINKS: 'VLINKS key element [WITHSCORES]',
  VRANDMEMBER: 'VRANDMEMBER key [count]',
  VRANGE: 'VRANGE key start end [count]',
  VSIM: 'VSIM key (ELE element | FP32 vector | VALUES num values...) [WITHSCORES] [WITHATTRIBS] [COUNT num]',
  'TS.GET': 'TS.GET key [LATEST]',
  'TS.INFO': 'TS.INFO key [DEBUG]',
  'TS.RANGE': 'TS.RANGE key fromTimestamp toTimestamp [LATEST] [FILTER_BY_TS timestamp ...] [FILTER_BY_VALUE min max] [COUNT count] [ALIGN align] [AGGREGATION aggregator bucketDuration]',
  'TS.REVRANGE': 'TS.REVRANGE key fromTimestamp toTimestamp [LATEST] [FILTER_BY_TS timestamp ...] [FILTER_BY_VALUE min max] [COUNT count] [ALIGN align] [AGGREGATION aggregator bucketDuration]',
  'TS.QUERYINDEX': 'TS.QUERYINDEX filter [filter ...]',
};

export const writeCMD: Record<string, RedisCommandSpec> = {
  APPEND: 'APPEND key value',
  ARDEL: 'ARDEL key index [index ...]',
  ARINSERT: 'ARINSERT key value [value ...]',
  ARMSET: 'ARMSET key index value [index value ...]',
  ARRING: 'ARRING key size value [value ...]',
  ARSEEK: 'ARSEEK key index',
  ARSET: 'ARSET key index value [value ...]',
  BITOP: 'BITOP operation destkey key [key ...]',
  BLMOVE: 'BLMOVE source destination LEFT|RIGHT LEFT|RIGHT timeout',
  BLPOP: 'BLPOP key [key ...] timeout',
  BRPOP: 'BRPOP key [key ...] timeout',
  BRPOPLPUSH: 'BRPOPLPUSH source destination timeout',
  BZPOPMAX: 'BZPOPMAX key [key ...] timeout',
  BZPOPMIN: 'BZPOPMIN key [key ...] timeout',
  COPY: 'COPY source destination [DB destination-db] [REPLACE]',
  DECR: 'DECR key',
  DECRBY: 'DECRBY key decrement',
  DEL: 'DEL key [key ...]',
  EVAL: 'EVAL script numkeys key [key ...] arg [arg ...]',
  EVALSHA: 'EVALSHA sha1 numkeys key [key ...] arg [arg ...]',
  EXPIRE: 'EXPIRE key seconds',
  EXPIREAT: 'EXPIREAT key timestamp',
  FLUSHALL: 'FLUSHALL',
  FLUSHDB: 'FLUSHDB',
  GEOADD: 'GEOADD key [NX|XX] [CH] longitude latitude member [longitude latitude member ...]',
  GETDEL: 'GETDEL key',
  GETSET: 'GETSET key value',
  HDEL: 'HDEL key field [field ...]',
  HINCRBY: 'HINCRBY key field increment',
  HINCRBYFLOAT: 'HINCRBYFLOAT key field increment',
  HMSET: 'HMSET key field value [field value ...]',
  HSET: 'HSET key field value',
  HSETNX: 'HSETNX key field value',
  INCR: 'INCR key',
  INCRBY: 'INCRBY key increment',
  INCRBYFLOAT: 'INCRBYFLOAT key increment',
  LINSERT: 'LINSERT key BEFORE|AFTER pivot value',
  LMOVE: 'LMOVE source destination LEFT|RIGHT LEFT|RIGHT',
  LPOP: 'LPOP key',
  LPUSH: 'LPUSH key value [value ...]',
  LPUSHX: 'LPUSHX key value',
  LREM: 'LREM key count value',
  LSET: 'LSET key index value',
  LTRIM: 'LTRIM key start stop',
  MIGRATE: 'MIGRATE host port key destination-db timeout',
  MOVE: 'MOVE key db',
  MSET: 'MSET key value [key value ...]',
  MSETNX: 'MSETNX key value [key value ...]',
  PERSIST: 'PERSIST key',
  PEXPIRE: 'PEXPIRE key milliseconds',
  PEXPIREAT: 'PEXPIREAT key milliseconds-timestamp',
  PSETEX: 'PSETEX key milliseconds value',
  PUBLISH: 'PUBLISH channel message',
  RENAME: 'RENAME key newkey',
  RENAMENX: 'RENAMENX key newkey',
  RESTORE: 'RESTORE key ttl serialized-value',
  RPOP: 'RPOP key',
  RPOPLPUSH: 'RPOPLPUSH source destination',
  RPUSH: 'RPUSH key value [value ...]',
  RPUSHX: 'RPUSHX key value',
  SADD: 'SADD key member [member ...]',
  SCRIPT: ['SCRIPT EXISTS script [script ...]', 'SCRIPT FLUSH', 'SCRIPT KILL', 'SCRIPT LOAD script'],
  SDIFFSTORE: 'SDIFFSTORE destination key [key ...]',
  SET: 'SET key value',
  SETBIT: 'SETBIT key offset value',
  SETEX: 'SETEX key seconds value',
  SETNX: 'SETNX key value',
  SETRANGE: 'SETRANGE key offset value',
  SINTERSTORE: 'SINTERSTORE destination key [key ...]',
  SMOVE: 'SMOVE source destination member',
  SORT: 'SORT key [BY pattern] [LIMIT offset count] [GET pattern [GET pattern ...]] [ASC|DESC] [ALPHA] [STORE destination]',
  SPOP: 'SPOP key',
  SREM: 'SREM key member [member ...]',
  SUNIONSTORE: 'SUNIONSTORE destination key [key ...]',
  SWAPDB: 'SWAPDB index1 index2',
  UNLINK: 'UNLINK key [key ...]',
  XADD: 'XADD key ID field string [field string ...]',
  // XREADGROUP 会写 PEL（消费组状态），从 readCMD 移入 writeCMD：只读模式必须拦截。
  XREADGROUP: 'XREADGROUP GROUP group consumer [COUNT count] [BLOCK milliseconds] [NOACK] STREAMS key [key ...] ID [ID ...]',
  XDEL: 'XDEL key ID [ID ...]',
  XGROUP: ['XGROUP CREATE key groupname id|$ [MKSTREAM]', 'XGROUP CREATECONSUMER key groupname consumername', 'XGROUP DELCONSUMER key groupname consumername', 'XGROUP DESTROY key groupname', 'XGROUP SETID key groupname id|$'],
  XTRIM: 'XTRIM key MAXLEN [~] count',
  'TS.ADD': 'TS.ADD key timestamp value [RETENTION retentionPeriod] [ENCODING <UNCOMPRESSED|COMPRESSED>] [CHUNK_SIZE size] [ON_DUPLICATE policy] [LABELS label value ...]',
  'TS.ALTER': 'TS.ALTER key [RETENTION retentionPeriod] [CHUNK_SIZE size] [DUPLICATE_POLICY policy] [LABELS label value ...]',
  'TS.CREATE': 'TS.CREATE key [RETENTION retentionPeriod] [ENCODING <UNCOMPRESSED|COMPRESSED>] [CHUNK_SIZE size] [DUPLICATE_POLICY policy] [LABELS label value ...]',
  'TS.CREATERULE': 'TS.CREATERULE sourceKey destKey AGGREGATION aggregator bucketDuration [alignTimestamp]',
  'TS.DECRBY': 'TS.DECRBY key value [TIMESTAMP timestamp] [RETENTION retentionPeriod] [UNCOMPRESSED] [CHUNK_SIZE size] [LABELS label value ...]',
  'TS.DEL': 'TS.DEL key fromTimestamp toTimestamp',
  'TS.DELETERULE': 'TS.DELETERULE sourceKey destKey',
  'TS.INCRBY': 'TS.INCRBY key value [TIMESTAMP timestamp] [RETENTION retentionPeriod] [UNCOMPRESSED] [CHUNK_SIZE size] [LABELS label value ...]',
  'TS.MADD': 'TS.MADD key timestamp value [key timestamp value ...]',
  ZADD: 'ZADD key score member [score] [member]',
  ZDIFFSTORE: 'ZDIFFSTORE destination numkeys key [key ...]',
  ZINCRBY: 'ZINCRBY key increment member',
  ZINTERSTORE: 'ZINTERSTORE destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM|MIN|MAX]',
  ZPOPMAX: 'ZPOPMAX key [count]',
  ZPOPMIN: 'ZPOPMIN key [count]',
  ZRANGESTORE: 'ZRANGESTORE dst src min max [BYSCORE|BYLEX] [REV] [LIMIT offset count]',
  ZREM: 'ZREM key member [member ...]',
  ZREMRANGEBYLEX: 'ZREMRANGEBYLEX key min max',
  ZREMRANGEBYRANK: 'ZREMRANGEBYRANK key start stop',
  ZREMRANGEBYSCORE: 'ZREMRANGEBYSCORE key min max',
  ZUNIONSTORE: 'ZUNIONSTORE destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM|MIN|MAX]',
  VADD: 'VADD key [REDUCE dim] (FP32 vector | VALUES num values...) element [CAS] [NOQUANT|BIN|Q8] [EF build-exploration-factor] [SETATTR attributes] [M numlinks]',
  VREM: 'VREM key element [element ...]',
  VSETATTR: 'VSETATTR key element attributes',
};

/** 全部命令表（与上游 allCMD 同构：admin < read < write 覆盖顺序）。 */
export const allCMD: Record<string, RedisCommandSpec> = { ...adminCMD, ...readCMD, ...writeCMD };

/** 归一化命令名：去空白并大写。 */
function normalizeName(name: string): string {
  return String(name ?? '').trim().toUpperCase();
}

/** 取第 i 个参数并大写（缺失返回空串）。 */
function argAt(args: readonly unknown[] | undefined, i: number): string {
  const v = args?.[i];
  return v === undefined || v === null ? '' : String(v).trim().toUpperCase();
}

/**
 * admin 写子命令 denylist（DevBelt 加强，上游缺失）。
 * 形如 `CONFIG SET` / `ACL SETUSER`：父命令命中且首参在列表内才判定为写。
 */
const ADMIN_WRITE_SUBCOMMANDS: Record<string, readonly string[]> = {
  ACL: ['SETUSER', 'DELUSER', 'LOAD', 'SAVE'],
  CONFIG: ['SET', 'REWRITE', 'RESETSTAT'],
  MODULE: ['LOAD', 'UNLOAD'],
  CLIENT: ['KILL'],
};

/** admin 写命令 denylist（整条命令即写，无子命令区分）。 */
const ADMIN_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'BGREWRITEAOF',
  'BGSAVE',
  'SHUTDOWN',
  'DEBUG',
  'FAILOVER',
  'REPLICAOF',
  'SLAVEOF',
  'SAVE',
  'MONITOR',
]);

/** 该命令是否为 admin 写命令（DevBelt 相对 ARDM 的加强）。 */
export function isAdminWriteCommand(name: string, args?: readonly unknown[]): boolean {
  const cmd = normalizeName(name);
  if (ADMIN_WRITE_COMMANDS.has(cmd)) return true;
  const subs = ADMIN_WRITE_SUBCOMMANDS[cmd];
  return subs ? subs.includes(argAt(args, 0)) : false;
}

/**
 * admin 命令的**只读子命令 allowlist**（fail-closed：不在列表内即视为写）。
 * 上游按 "admin 写 denylist" 放行，会漏掉新写子命令（CLUSTER RESET/FAILOVER、MODULE LOADEX…）；
 * 这里反转为只认已知只读子命令，未知一律拦截。
 */
const ADMIN_READ_SUBCOMMANDS: Record<string, readonly string[]> = {
  ACL: ['CAT', 'DRYRUN', 'GENPASS', 'GETUSER', 'LIST', 'LOG', 'USERS', 'WHOAMI'],
  CLIENT: ['LIST', 'GETNAME', 'ID', 'INFO'],
  CLUSTER: ['INFO', 'NODES', 'SLOTS', 'SHARDS', 'MYID', 'LINKS', 'KEYSLOT', 'COUNTKEYSINSLOT', 'GETKEYSINSLOT', 'COUNT-FAILURE-REPORTS', 'REPLICAS', 'SLAVES'],
  CONFIG: ['GET'],
  DEBUG: ['OBJECT'],
  LATENCY: ['DOCTOR', 'GRAPH', 'HISTOGRAM', 'HISTORY', 'LATEST'],
  MEMORY: ['DOCTOR', 'HELP', 'MALLOC-STATS', 'STATS', 'USAGE'],
  MODULE: ['LIST'],
  SLOWLOG: ['GET', 'LEN', 'HELP', 'COUNT'],
  // sentinel-over-SSH 发现 master 需要它；fail-closed 漏了它会把整条 SSH sentinel 路径拦死。
  SENTINEL: ['MASTERS', 'MASTER', 'GET-MASTER-ADDR-BY-NAME', 'REPLICAS', 'SLAVES', 'SENTINELS', 'CKQUORUM', 'MYID', 'INFO-CACHE', 'IS-MASTER-DOWN-BY-ADDR'],
};

/** admin 命令是否为已知只读子命令（fail-closed）。 */
export function isAdminReadCommand(name: string, args?: readonly unknown[]): boolean {
  const cmd = normalizeName(name);
  const sub = argAt(args, 0);
  // ACL LOG 是只读，但 ACL LOG RESET 会清空日志（写）→ 特判拒绝。
  if (cmd === 'ACL' && sub === 'LOG' && argAt(args, 1) === 'RESET') return false;
  const subs = ADMIN_READ_SUBCOMMANDS[cmd];
  return !!subs && subs.includes(sub);
}

/**
 * 只读模式**放行**判定（fail-closed）：仅 readCMD 命中，或 admin 命令的已知只读子命令。
 * 未收录的新命令/新子命令一律视为写（拦截），避免"漏列即放行"。
 */
export function isReadCommand(name: string, args?: readonly unknown[]): boolean {
  const cmd = normalizeName(name);
  if (Object.prototype.hasOwnProperty.call(readCMD, cmd)) return true;
  return isAdminReadCommand(cmd, args);
}

/**
 * 只读模式是否应拦截该命令：命中 writeCMD（含修正后的 BITOP）或 admin 写 denylist。
 * 见 P7 §6.6：`isWriteCommand` = ARDM writeCMD 命中 或 admin 写 denylist 命中。
 */
export function isWriteCommand(name: string, args?: readonly unknown[]): boolean {
  const cmd = normalizeName(name);
  if (Object.prototype.hasOwnProperty.call(writeCMD, cmd)) return true;
  return isAdminWriteCommand(cmd, args);
}

/** `CONFIG` 的危险子命令。 */
const DANGEROUS_CONFIG_SUBCOMMANDS: readonly string[] = ['SET', 'REWRITE', 'RESETSTAT'];

/**
 * 危险命令（需二次确认）：破坏性删除/停机/配置锁定——FLUSHALL/FLUSHDB/SHUTDOWN/CONFIG SET|REWRITE|RESETSTAT。
 * 见 P7 §6.2。`KEYS` 属只读扫描（虽大）不在此列：控制台不弹确认、直接出结果。
 */
export function isDangerousCommand(name: string, args?: readonly unknown[]): boolean {
  const cmd = normalizeName(name);
  if (cmd === 'FLUSHALL' || cmd === 'FLUSHDB' || cmd === 'SHUTDOWN') return true;
  if (cmd === 'CONFIG') return DANGEROUS_CONFIG_SUBCOMMANDS.includes(argAt(args, 0));
  return false;
}

/** 全部命令名（升序），供补全候选。 */
export function allCommandNames(): string[] {
  return Object.keys(allCMD).sort();
}

/** 按前缀过滤补全候选（大小写不敏感）。 */
export function commandCompletions(prefix = ''): string[] {
  const p = normalizeName(prefix);
  return allCommandNames().filter((c) => c.startsWith(p));
}
