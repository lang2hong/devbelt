import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import {
  isDangerousCommand, isWriteCommand, redactCommandArgs, splitRedisArgs,
  redisType, redisScan, redisSelect, redisGetBuffer, redisStrlen, redisSet, redisSetBuffer, redisAppend,
  isValidUtf8, isBufferSource,
  redisUnlink, redisExists, redisRename, redisTtl, redisExpire, redisPersist, redisMemoryUsage,
  redisHScan, redisHSet, redisHDel, redisHLen,
  redisLRange, redisLLen, redisLPush, redisRPush, redisLSet, redisLRem, redisLTrim, redisLPop, redisRPop,
  redisSScan, redisSCard, redisSAdd, redisSRem,
  redisZRange, redisZCard, redisZAdd, redisZRem, allCommandNames, redisScanOnNode,
  redisXRange, redisXRevRange, redisXAdd, redisXDel, redisXTrimMaxlen, redisXLen,
  redisXInfoGroups, redisXInfoConsumers, redisXGroupCreate, redisXGroupDestroy, redisXGroupDelConsumer,
  redisXPending, isValidStreamId, compareStreamId,
  type RedisCommandSource,
} from '@devbelt/db-core';
import type { RedisConnectionSession } from '../connection/connectionSession';
import { ConnectionManager } from '../connection/connectionManager';
import { REDIS_CAPABILITIES } from '../connection/redisCapabilities';
import { BaseWebView } from './baseWebView';
import { foldRedisKeys } from './redisKeyFold';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';
import type { RedisNewKeyValue, RedisSlowlogEntry, RedisTab, RedisValueData } from './protocol';

/** 大 key 门禁阈值（字节）。 */
const LARGE_KEY_BYTES = 1024 * 1024;
/** SCAN 默认 COUNT。 */
const DEFAULT_SCAN_COUNT = 200;
/** Stream 单页条目数。 */
const STREAM_PAGE = 100;
/** hash/set 单页条目数（大集合分页兜底，避免全量 HGETALL/SMEMBERS）。 */
const HASH_SET_PAGE = 200;

/** Redis 面板：DB 键树 + 值查看/编辑 + CLI/SlowLog 三栏（P7 S2/S3）。 */
export class RedisView extends BaseWebView {
  private static current?: RedisView;
  private pendingConfirm?: { id: string; line: string; name: string; args: string[] };

  // S3 键树状态
  private cursor = '0';
  /** cluster：各 master 的 SCAN 游标。 */
  private clusterCursors: string[] = [];
  private keys: string[] = [];
  private match = '';
  private scanCount = DEFAULT_SCAN_COUNT;
  /** 串行化会话操作：SELECT 是连接级状态，避免 DB 切换与并发操作交叠。 */
  private opChain: Promise<unknown> = Promise.resolve();
  /** 服务器状态视图（无 DB 绑定）：不发键树，只推 INFO/SlowLog。 */
  private readonly statusOnly: boolean;
  /** 命令日志订阅（会话 client 级；首次取会话时挂上）。 */
  private logUnsub?: () => void;
  /** 连接/故障切换事件是否已订阅（每会话一次）。 */
  private eventsBound = false;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly initialTab: RedisTab,
    private readonly db?: number,
  ) {
    super('devbelt.redis', `Redis @ ${conn.name || conn.host}`);
    this.statusOnly = initialTab === 'status' && db === undefined;
    this.manager.retain(conn.id);
  }

  static open(conn: SavedConnection, manager: ConnectionManager, tab: RedisTab = 'status', db?: number): void {
    if (RedisView.current) RedisView.current.dispose();
    RedisView.current = new RedisView(conn, manager, tab, db);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'redis' });
        return;
      }
      this.post({
        type: 'config',
        connName: this.conn.name || this.conn.host,
        host: this.conn.host,
        port: this.conn.port,
        db: this.statusOnly ? null : (this.db ?? this.conn.redisDb ?? 0),
        readOnly: this.conn.readOnly === true,
        connMode: this.conn.redisMode ?? 'standalone',
        redisTab: this.initialTab,
        commands: allCommandNames(),
      });
      // 键浏览器（含连接级 console，落 conn.redisDb，默认 db0）；状态视图只推 INFO/SlowLog。
      if (!this.statusOnly) await this.enqueuePushKeys(true);
      await this.pushInfo();
      await this.pushSlowlog();
      return;
    }
    if (msg.type === 'refreshInfo') { await this.pushInfo(); return; }
    if (msg.type === 'refreshSlowlog') { await this.pushSlowlog(); return; }
    if (msg.type === 'runCommand') { await this.runCommand(String(msg.id ?? ''), String(msg.line ?? '')); return; }
    if (msg.type === 'confirmDanger') { await this.resolveConfirm(String(msg.id ?? ''), msg.accept === true); return; }
    if (msg.type === 'refreshKeys') { await this.refreshKeys(msg); return; }
    if (msg.type === 'loadMoreKeys') { await this.enqueuePushKeys(false); return; }
    if (msg.type === 'selectKey') { await this.enqueuePushValue(String(msg.key ?? '')); return; }
    if (msg.type === 'saveString') { await this.edit('SET', String(msg.key), async (c) => { await redisSet(c, String(msg.key), String(msg.value ?? '')); }); return; }
    if (msg.type === 'saveStringBytes') { await this.saveStringBytes(msg); return; }
    if (msg.type === 'appendString') { await this.edit('APPEND', String(msg.key), async (c) => { await redisAppend(c, String(msg.key), String(msg.value ?? '')); }); return; }
    if (msg.type === 'setTtl') { await this.edit('EXPIRE', String(msg.key), async (c) => { const s = Number(msg.seconds); if (s > 0) await redisExpire(c, String(msg.key), s); else await redisPersist(c, String(msg.key)); }); return; }
    if (msg.type === 'persistKey') { await this.edit('PERSIST', String(msg.key), async (c) => { await redisPersist(c, String(msg.key)); }); return; }
    if (msg.type === 'renameKey') { await this.renameKey(String(msg.key), String(msg.newKey ?? '')); return; }
    if (msg.type === 'deleteKeys') { await this.deleteKeys(Array.isArray(msg.keys) ? msg.keys.map(String) : []); return; }
    if (msg.type === 'createKey') { await this.createKey(msg); return; }
    if (msg.type === 'hashSet') { await this.edit('HSET', String(msg.key), async (c) => { await redisHSet(c, String(msg.key), String(msg.field ?? ''), String(msg.value ?? '')); }); return; }
    if (msg.type === 'hashDel') { await this.edit('HDEL', String(msg.key), async (c) => { await redisHDel(c, String(msg.key), strs(msg.fields)); }); return; }
    if (msg.type === 'listPush') { await this.edit('LPUSH/RPUSH', String(msg.key), async (c) => { const v = strs(msg.values); if (msg.side === 'left') await redisLPush(c, String(msg.key), v); else await redisRPush(c, String(msg.key), v); }); return; }
    if (msg.type === 'listSet') { await this.edit('LSET', String(msg.key), async (c) => { await redisLSet(c, String(msg.key), Number(msg.index), String(msg.value ?? '')); }); return; }
    if (msg.type === 'listRem') { await this.edit('LREM', String(msg.key), async (c) => { await redisLRem(c, String(msg.key), Number(msg.count), String(msg.value ?? '')); }); return; }
    if (msg.type === 'listTrim') { await this.edit('LTRIM', String(msg.key), async (c) => { await redisLTrim(c, String(msg.key), Number(msg.start), Number(msg.stop)); }); return; }
    if (msg.type === 'listPop') { await this.edit('LPOP/RPOP', String(msg.key), async (c) => { if (msg.side === 'left') await redisLPop(c, String(msg.key)); else await redisRPop(c, String(msg.key)); }); return; }
    if (msg.type === 'setAdd') { await this.edit('SADD', String(msg.key), async (c) => { await redisSAdd(c, String(msg.key), strs(msg.members)); }); return; }
    if (msg.type === 'setRem') { await this.edit('SREM', String(msg.key), async (c) => { await redisSRem(c, String(msg.key), strs(msg.members)); }); return; }
    if (msg.type === 'zsetAdd') { await this.edit('ZADD', String(msg.key), async (c) => { await redisZAdd(c, String(msg.key), String(msg.score ?? '0'), String(msg.member ?? '')); }); return; }
    if (msg.type === 'zsetRem') { await this.edit('ZREM', String(msg.key), async (c) => { await redisZRem(c, String(msg.key), strs(msg.members)); }); return; }
    if (msg.type === 'streamAdd') { await this.streamAdd(msg); return; }
    if (msg.type === 'streamDel') { await this.streamDelOp(msg); return; }
    if (msg.type === 'streamTrim') { await this.streamTrimOp(msg); return; }
    if (msg.type === 'streamGroupCreate') { await this.streamGroupCreateOp(msg); return; }
    if (msg.type === 'streamGroupDestroy') { await this.streamGroupDestroyOp(msg); return; }
    if (msg.type === 'streamGroupDelConsumer') { await this.streamGroupDelConsumerOp(msg); return; }
    if (msg.type === 'streamGroupDetail') { await this.streamGroupDetailOp(msg); return; }
    if (msg.type === 'streamRange') { await this.streamRangeOp(msg); return; }
  }

  protected onDispose(): void {
    super.onDispose();
    this.logUnsub?.();
    this.logUnsub = undefined;
    if (RedisView.current === this) RedisView.current = undefined;
    this.manager.release(this.conn.id);
  }

  // ────────────────────────── 会话 ──────────────────────────

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sessionForDb(): Promise<RedisConnectionSession> {
    const session = await this.manager.connect(this.conn);
    if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
    // 无论本视图是否绑定 DB 节点，都把共享会话归一到确定目标：否则上一视图的
    // SELECT 会泄漏到连接级面板（UI/审计写 db0，命令却落在旧库）。
    // Cluster 无 SELECT，跳过（键按 slot 路由）。
    const target = this.db ?? this.conn.redisDb ?? 0;
    if (!session.client.isCluster && target !== session.db) {
      await redisSelect(session.client, target);
      session.db = target;
    }
    // 订阅连接/故障切换事件（sentinel 切换会经历 reconnecting→ready；cluster 扩缩容同理）。
    if (!this.eventsBound && typeof session.client.on === 'function') {
      this.eventsBound = true;
      for (const ev of ['connect', 'ready', 'reconnecting', 'end', 'close', 'error']) {
        session.client.on(ev, (...args: unknown[]) => {
          const detail = args.length && args[0] != null ? String(args[0]) : null;
          this.post({ type: 'connectionEvent', event: ev, detail, at: Date.now() });
          if (ev === 'reconnecting' || ev === 'end') {
            AuditLogger.tryLog({
              action: 'redis_command',
              connName: this.conn.name || this.conn.host,
              database: String(this.db ?? this.conn.redisDb ?? 0),
              sql: `connection:${ev}`,
            });
          }
        });
      }
    }

    // 首次取会话时订阅命令日志（所有命令，含非 CLI 路径），逐条下发给 CommandLog 面板。
    if (!this.logUnsub && typeof session.client.addLogListener === 'function') {
      this.logUnsub = session.client.addLogListener((entry) => {
        this.post({
          type: 'commandLog',
          entry: { command: entry.command, args: entry.args, durationMs: entry.durationMs, ok: entry.ok, error: entry.error ?? null },
        });
      });
    }
    return session;
  }

  private async pushInfo(): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
      this.post({ type: 'info', info: await session.client.info() });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async pushSlowlog(): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
      const raw = await session.client.sendCommand('SLOWLOG', ['GET', '128']);
      this.post({ type: 'slowlog', entries: parseSlowlog(raw) });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  // ────────────────────────── 键树 ──────────────────────────

  private async refreshKeys(msg: any): Promise<void> {
    this.match = String(msg.match ?? '');
    const count = Number(msg.count);
    this.scanCount = Number.isFinite(count) && count > 0 ? count : DEFAULT_SCAN_COUNT;
    await this.enqueuePushKeys(true);
  }

  private async enqueuePushKeys(reset: boolean): Promise<void> {
    await this.enqueue(async () => {
      const session = await this.sessionForDb();
      await this.doPushKeys(session, reset);
    }).catch((err) => this.post({ type: 'error', message: (err as Error).message }));
  }

  private async doPushKeys(session: RedisConnectionSession, reset: boolean): Promise<void> {
    try {
      const foldersOf = (): void => {
        const folders = foldRedisKeys(this.keys, this.conn.keySeparator || ':');
        const done = session.client.isCluster
          ? this.clusterCursors.every((c) => c === '0')
          : this.cursor === '0';
        this.post({ type: 'keys', folders, cursor: done ? '0' : '1', done, scanned: this.keys.length, match: this.match });
      };

      // Cluster：逐 master SCAN（SCAN 无 key 无法路由），各自维护游标。
      if (session.client.isCluster) {
        const nodes = session.client.nodes();
        if (reset || this.clusterCursors.length !== nodes.length) this.clusterCursors = nodes.map(() => '0');
        if (reset) this.keys = [];
        const next: string[] = [];
        const batch: string[] = [];
        for (let i = 0; i < nodes.length; i++) {
          const page = await redisScanOnNode(nodes[i], this.clusterCursors[i] ?? '0', {
            match: this.match || undefined,
            count: this.scanCount,
          });
          next[i] = page.cursor;
          batch.push(...page.keys);
        }
        this.clusterCursors = next;
        this.keys = [...new Set([...this.keys, ...batch])];
        foldersOf();
        return;
      }

      if (reset) { this.cursor = '0'; this.keys = []; }
      const result = await redisScan(session.client, this.cursor, {
        match: this.match || undefined,
        count: this.scanCount,
      });
      // SCAN 语义允许重复返回同一 key：累积去重，避免 scanned 虚高与内存增长。
      this.keys = [...new Set([...this.keys, ...result.keys])];
      this.cursor = result.cursor;
      foldersOf();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  // ────────────────────────── 值查看/编辑 ──────────────────────────

  private async enqueuePushValue(key: string): Promise<void> {
    await this.enqueue(async () => {
      const session = await this.sessionForDb();
      await this.doPushValue(session, key);
    }).catch((err) => this.post({ type: 'error', message: (err as Error).message }));
  }

  private async doPushValue(session: RedisConnectionSession, key: string): Promise<void> {
    try {
      const c = session.client;
      const keyType = await redisType(c, key);
      const ttl = await redisTtl(c, key);
      const size = keyType === 'string' ? await redisStrlen(c, key) : await redisMemoryUsage(c, key);
      const tooLarge = size !== null && size > LARGE_KEY_BYTES;
      const data = tooLarge ? null : await this.loadValue(c, key, keyType);
      this.post({ type: 'value', key, keyType, ttl, tooLarge, size, data });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async loadValue(c: RedisCommandSource, key: string, keyType: string): Promise<RedisValueData | null> {
    switch (keyType) {
      case 'string': {
        const buf = await redisGetBuffer(c, key);
        return {
          kind: 'string',
          text: buf ? buf.toString('utf8') : '',
          base64: buf ? buf.toString('base64') : '',
          binary: buf ? !isValidUtf8(buf) : false,
          bytes: buf ? buf.length : 0,
        };
      }
      case 'hash': {
        // 分页兜底：MEMORY USAGE 不可用/大 key 时也不全量 HGETALL。
        const page = await redisHScan(c, key, 0, { count: HASH_SET_PAGE });
        return { kind: 'hash', entries: page.entries, len: await redisHLen(c, key) };
      }
      case 'list': return { kind: 'list', items: await redisLRange(c, key, 0, 199), len: await redisLLen(c, key) };
      case 'set': {
        const page = await redisSScan(c, key, 0, { count: HASH_SET_PAGE });
        return { kind: 'set', members: page.keys, card: await redisSCard(c, key) };
      }
      case 'zset': return { kind: 'zset', items: await redisZRange(c, key, 0, 199), card: await redisZCard(c, key) };
      case 'stream': return {
        kind: 'stream',
        entries: await redisXRange(c, key, '-', '+', STREAM_PAGE),
        len: await redisXLen(c, key),
        groups: await redisXInfoGroups(c, key),
      };
      default: return null;
    }
  }

  /** 执行一次键编辑并刷新值；失败回 keyAction error。 */
  private async edit(action: string, key: string, fn: (c: RedisCommandSource) => Promise<void>): Promise<void> {
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const started = Date.now();
        await fn(session.client);
        this.audit(action, key, Date.now() - started);
        this.post({ type: 'keyAction', action, ok: true, error: null });
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action, ok: false, error: (err as Error).message });
      }
    });
  }

  /** 字节级保存 string（hex/二进制编辑）：base64 → Buffer，保留非 UTF-8 字节。 */
  private async saveStringBytes(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const base64 = String(msg.base64 ?? '');
    await this.edit('SET', key, async (c) => {
      if (!isBufferSource(c)) throw new Error('binary write unsupported by this connection');
      await redisSetBuffer(c, key, Buffer.from(base64, 'base64'));
    });
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const started = Date.now();
        // UNLINK：异步回收，避免大集合删除阻塞 Redis 主线程。
        await redisUnlink(session.client, keys);
        this.audit('UNLINK', keys.join(' '), Date.now() - started);
        this.post({ type: 'keyAction', action: 'UNLINK', ok: true, error: null });
        await this.doPushKeys(session, true);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'UNLINK', ok: false, error: (err as Error).message });
      }
    });
  }

  private async createKey(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const value = msg.value as RedisNewKeyValue | undefined;
    if (!key || !value) { this.post({ type: 'keyAction', action: 'CREATE', ok: false, error: l10n('cmd.redis.emptyCommand') }); return; }
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const c = session.client;
        if (await redisExists(c, key)) {
          this.post({ type: 'keyAction', action: 'CREATE', ok: false, error: l10n('cmd.redis.keyExists') });
          return;
        }
        const started = Date.now();
        if (value.kind === 'string') await redisSet(c, key, value.text);
        else if (value.kind === 'hash') { for (const [f, v] of value.entries) await redisHSet(c, key, f, v); }
        else if (value.kind === 'list') { if (value.items.length) await redisRPush(c, key, value.items); }
        else if (value.kind === 'set') { if (value.members.length) await redisSAdd(c, key, value.members); }
        else if (value.kind === 'zset') { for (const [m, s] of value.items) await redisZAdd(c, key, s, m); }
        const ttl = Number(msg.ttlSeconds);
        if (Number.isFinite(ttl) && ttl > 0) await redisExpire(c, key, ttl);
        this.audit('CREATE', key, Date.now() - started);
        this.post({ type: 'keyAction', action: 'CREATE', ok: true, error: null });
        await this.doPushKeys(session, true);
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'CREATE', ok: false, error: (err as Error).message });
      }
    });
  }

  // ────────────────────────── CLI（S2） ──────────────────────────

  private async runCommand(id: string, line: string): Promise<void> {
    if (!REDIS_CAPABILITIES.cli) {
      this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.cliUnsupported') });
      return;
    }
    let parts: string[];
    try {
      parts = splitRedisArgs(line);
    } catch (err) {
      this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: (err as Error).message });
      return;
    }
    if (!parts.length) {
      this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.emptyCommand') });
      return;
    }
    const name = parts[0].toUpperCase();
    const args = parts.slice(1);
    if (isDangerousCommand(name, args)) {
      this.pendingConfirm = { id, line, name, args };
      this.post({ type: 'confirmRequired', id, command: line });
      return;
    }
    await this.execute(id, line, name, args);
  }

  private async resolveConfirm(id: string, accept: boolean): Promise<void> {
    const pending = this.pendingConfirm;
    this.pendingConfirm = undefined;
    if (!pending || pending.id !== id) return;
    if (!accept) {
      this.post({ type: 'commandResult', id, command: pending.line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.dangerCancelled') });
      return;
    }
    await this.execute(pending.id, pending.line, pending.name, pending.args);
  }

  private async execute(id: string, line: string, name: string, args: string[]): Promise<void> {
    const started = Date.now();
    try {
      const session = await this.sessionForDb();
      const raw = await session.client.sendCommand(name, args);
      const costMs = Date.now() - started;
      if (isWriteCommand(name, args) || isDangerousCommand(name, args)) {
        this.audit(name, redisAuditLine(name, args).slice(name.length).trim(), costMs);
      }
      this.post({ type: 'commandResult', id, command: line, ok: true, result: formatRedisReply(raw), costMs, error: null });
    } catch (err) {
      this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: (err as Error).message });
    }
  }

  // ────────────────────────── Stream（S4） ──────────────────────────

  /** 破坏性操作：未带 confirmed 时先回确认请求，由 webview 二次下发。 */
  private needConfirm(msg: any, kind: string, detail: string): boolean {
    if (msg.confirmed === true) return false;
    this.post({ type: 'confirmOpRequired', kind, detail });
    return true;
  }

  private async streamAdd(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const id = String(msg.id ?? '*');
    const fields = pairsOf(msg.fields);
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const c = session.client;
        if (id !== '*') {
          if (!isValidStreamId(id)) {
            this.post({ type: 'keyAction', action: 'XADD', ok: false, error: l10n('cmd.redis.streamInvalidId') });
            return;
          }
          const last = await redisXRevRange(c, key, '+', '-', 1);
          const lastId = last[0]?.id;
          if (lastId && compareStreamId(id, lastId) <= 0) {
            this.post({ type: 'keyAction', action: 'XADD', ok: false, error: l10n('cmd.redis.streamIdNotGreater') });
            return;
          }
        }
        const started = Date.now();
        await redisXAdd(c, key, fields, id);
        this.audit('XADD', key, Date.now() - started);
        this.post({ type: 'keyAction', action: 'XADD', ok: true, error: null });
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'XADD', ok: false, error: (err as Error).message });
      }
    });
  }

  private async streamDelOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const ids = strs(msg.ids);
    if (!ids.length) return;
    // 单条走普通管线；批量走确认。
    if (ids.length > 1 && this.needConfirm(msg, 'streamDel', `${ids.length} entries`)) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const started = Date.now();
        await redisXDel(session.client, key, ids);
        this.audit('XDEL', key, Date.now() - started);
        this.post({ type: 'keyAction', action: 'XDEL', ok: true, error: null });
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'XDEL', ok: false, error: (err as Error).message });
      }
    });
  }

  private async streamTrimOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const maxlen = Number(msg.maxlen);
    if (!Number.isFinite(maxlen) || maxlen < 0) return;
    if (this.needConfirm(msg, 'streamTrim', `MAXLEN ${maxlen}`)) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const started = Date.now();
        await redisXTrimMaxlen(session.client, key, maxlen);
        this.audit('XTRIM', key, Date.now() - started);
        this.post({ type: 'keyAction', action: 'XTRIM', ok: true, error: null });
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'XTRIM', ok: false, error: (err as Error).message });
      }
    });
  }

  private async streamGroupCreateOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    if (!group) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        await redisXGroupCreate(session.client, key, group, String(msg.id ?? '$'), msg.mkstream !== false);
        this.audit('XGROUP CREATE', `${key} ${group}`);
        this.post({ type: 'keyAction', action: 'XGROUP', ok: true, error: null });
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'XGROUP', ok: false, error: (err as Error).message });
      }
    });
  }

  private async streamGroupDestroyOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    if (!group) return;
    if (this.needConfirm(msg, 'streamGroupDestroy', group)) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        await redisXGroupDestroy(session.client, key, group);
        this.audit('XGROUP DESTROY', `${key} ${group}`);
        this.post({ type: 'keyAction', action: 'XGROUP', ok: true, error: null });
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'XGROUP', ok: false, error: (err as Error).message });
      }
    });
  }

  private async streamGroupDelConsumerOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    const consumer = String(msg.consumer ?? '');
    if (!group || !consumer) return;
    if (this.needConfirm(msg, 'streamGroupDelConsumer', `${group}/${consumer}`)) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        await redisXGroupDelConsumer(session.client, key, group, consumer);
        this.audit('XGROUP DELCONSUMER', `${key} ${group} ${consumer}`);
        this.post({ type: 'keyAction', action: 'XGROUP', ok: true, error: null });
        await this.doPushValue(session, key);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'XGROUP', ok: false, error: (err as Error).message });
      }
    });
  }

  private async streamGroupDetailOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const group = String(msg.group ?? '');
    if (!group) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const [consumers, pending] = await Promise.all([
          redisXInfoConsumers(session.client, key, group),
          redisXPending(session.client, key, group),
        ]);
        this.post({ type: 'streamGroupDetail', key, group, consumers, pending });
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
    });
  }

  private async streamRangeOp(msg: any): Promise<void> {
    const key = String(msg.key ?? '');
    const start = String(msg.start ?? '-');
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        // 排他续页：起点用 `(<lastId>`，避免重复末条。
        const entries = await redisXRange(session.client, key, start === '-' ? '-' : `(${start}`, '+', STREAM_PAGE);
        this.post({ type: 'streamRangeResult', key, entries, done: entries.length < STREAM_PAGE });
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
    });
  }

  private audit(command: string, detail: string, costTime?: number): void {
    AuditLogger.tryLog({
      action: 'redis_command',
      connName: this.conn.name || this.conn.host,
      database: String(this.db ?? this.conn.redisDb ?? 0),
      sql: `${command} ${detail}`.trim(),
      costTime,
    });
  }

  /** 重命名：目标已存在则拒绝（避免静默覆盖目标键）。 */
  private async renameKey(key: string, newKey: string): Promise<void> {
    if (!key || !newKey) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        if (await redisExists(session.client, newKey)) {
          this.post({ type: 'keyAction', action: 'RENAME', ok: false, error: l10n('cmd.redis.renameTargetExists') });
          return;
        }
        const started = Date.now();
        await redisRename(session.client, key, newKey);
        this.audit('RENAME', key, Date.now() - started);
        this.post({ type: 'keyAction', action: 'RENAME', ok: true, error: null });
        await this.doPushKeys(session, true);
        await this.doPushValue(session, newKey);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'RENAME', ok: false, error: (err as Error).message });
      }
    });
  }
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** `[[f,v],…]` 归一化。 */
function pairsOf(v: unknown): [string, string][] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is unknown[] => Array.isArray(e) && e.length >= 2).map((e) => [String(e[0]), String(e[1])]);
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
