import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import {
  isDangerousCommand, isWriteCommand, redactCommandArgs, splitRedisArgs,
  redisType, redisSelect, redisGetBuffer, redisGetRangeBuffer, redisStrlen, redisSet, redisSetBuffer, redisAppend,
  isValidUtf8, isBufferSource,
  redisUnlink, redisExists, redisRename, redisTtl, redisExpire, redisPersist, redisMemoryUsage,
  redisHScan, redisHSet, redisHDel, redisHLen, redisHExists,
  redisLRange, redisLLen, redisLPush, redisRPush, redisLSet, redisLRem, redisLTrim, redisLPop, redisRPop, redisLIndex,
  redisSScan, redisSCard, redisSAdd, redisSRem,
  redisZRange, redisZCard, redisZAdd, redisZRem, redisZScore, allCommandNames,
  redisXRange, redisXRevRange, redisXAdd, redisXDel, redisXTrimMaxlen, redisXLen,
  redisXInfoGroups, redisXInfoConsumers, redisXGroupCreate, redisXGroupDestroy, redisXGroupDelConsumer,
  redisXPending, isValidStreamId, compareStreamId,
  redisInfoOnNode,
  type RedisCommandSource,
} from '@devbelt/db-core';
import type { RedisConnectionSession } from '../connection/connectionSession';
import { ConnectionManager } from '../connection/connectionManager';
import { REDIS_CAPABILITIES } from '../connection/redisCapabilities';
import { BaseWebView } from './baseWebView';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';
import type { RedisPanel, RedisSlowlogEntry, RedisValueData, RedisUpMessage } from './protocol';
import { parseRedisInfo, aggregateRedisInfo } from './redisInfoParse';

/** 大 key 门禁阈值（字节）。 */
const LARGE_KEY_BYTES = 1024 * 1024;
/** 大 key「强制加载」的硬上限：string 超过只用 GETRANGE 预览，避免宿主内存暴涨。 */
const FORCE_LOAD_MAX_BYTES = 32 * 1024 * 1024;
/** Stream 单页条目数。 */
const STREAM_PAGE = 100;
/** hash/set 单页条目数（大集合分页兜底，避免全量 HGETALL/SMEMBERS）。 */
const HASH_SET_PAGE = 200;

/**
 * H5 最低要求：文本内容含替换符 U+FFFD，说明原始字节不是合法 UTF-8（ioredis 按文本解码有损）。
 * 有损文本回写会破坏二进制数据，故这类键/字段/成员一律只读；完整二进制安全延后。
 */
function hasReplacement(s: string): boolean {
  return s.includes('\uFFFD');
}

/** 面板对应的 webview viewType。 */
function redisViewType(panel: RedisPanel): string {
  return `devbelt.redis.${panel}`;
}

/** 面板标题（连接名 + 职责，值面板附 db）。 */
function redisPanelTitle(panel: RedisPanel, conn: SavedConnection, db?: number): string {
  const base = `Redis @ ${conn.name || conn.host}`;
  switch (panel) {
    case 'keyBrowser': {
      const values = l10n('redis.panel.values');
      return db === undefined ? `${base} · ${values}` : `${base} · ${values} · db${db}`;
    }
    case 'serverStatus': return `${base} · Status`;
    case 'monitor': return `${base} · Monitor`;
    case 'console': return `${base} · Console`;
    case 'slowlog': return `${base} · Slow Log`;
    case 'commandLog': return `${base} · Command Log`;
  }
}

/**
 * Redis 面板（S5：按职责拆分为独立 webview）。
 *
 * 每个 (conn.id, panel) 维护一个实例（注册表），不再单例顶替；同连接的多个面板
 * 共享一条 session，`SELECT` 归一与命令经 `RedisClient.runExclusive` 串行（S5 并发隔离）。
 */
export class RedisView extends BaseWebView {
  private static readonly instances = new Map<string, RedisView>();
  /** `connection:*` 审计责任面板：每连接仅一个实例负责写（避免多面板重复）。 */
  private static readonly auditOwners = new Map<string, RedisView>();
  private pendingConfirm?: { id: string; line: string; name: string; args: (string | Buffer)[]; db: number };

  /** 命令日志订阅（会话 client 级；首次取会话/就绪时挂上）。 */
  private logUnsub?: () => void;
  /** 连接/故障切换事件是否已订阅（每实例一次）。 */
  private eventsBound = false;
  /** 已绑定的会话 client 与事件处理器（dispose 时移除，避免面板关闭后仍 post）。 */
  private boundClient?: { on?(ev: string, h: (...a: unknown[]) => void): unknown; off?(ev: string, h: (...a: unknown[]) => void): unknown };
  private readonly boundEvents: { ev: string; handler: (...a: unknown[]) => void }[] = [];
  /** dispose 后置位：作为 post 兜底，丢弃迟到的异步回调。 */
  private disposed = false;
  /** 注册表键 `${conn.id}:${panel}`，onDispose 清理。 */
  private readonly registryKey: string;
  /** S5-3：树点键时带的首选键（就绪后自动加载其值）。 */
  private initialKey?: string;
  /** 最近一次查看的键（树侧写操作后据此刷新值）。 */
  private lastKey?: string;
  /** H5：当前键名解码含替换符（非 UTF-8）→ 只读。 */
  private keyBinary = false;
  /** H5：当前值里解码含替换符的字段/成员/元素 → 这些项只读（防有损回写）。 */
  private binaryTokens = new Set<string>();

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly panelType: RedisPanel,
    private db?: number,
    initialKey?: string,
  ) {
    super(redisViewType(panelType), redisPanelTitle(panelType, conn, db));
    this.initialKey = initialKey;
    this.manager.retain(conn.id);
    this.registryKey = `${conn.id}:${panelType}`;
  }

  /**
   * 打开面板。同 (conn,panel) 已存在则聚焦；keyBrowser 且 db 变化则切换并重载键树。
   * `selectKey`（S5-3，树点键）会聚焦并加载该键的值。
   * 返回实例（便于测试/聚焦）。
   */
  static open(conn: SavedConnection, manager: ConnectionManager, panel: RedisPanel, db?: number, selectKey?: string): RedisView {
    const existing = RedisView.instances.get(`${conn.id}:${panel}`);
    if (existing) {
      if ((panel === 'keyBrowser' || panel === 'console') && db !== undefined && db !== existing.db) {
        existing.db = db;
        existing.initialKey = selectKey;
        void existing.reconfigure();
      } else if (selectKey) {
        void existing.enqueuePushValue(selectKey);
      }
      existing.reveal();
      return existing;
    }
    const view = new RedisView(conn, manager, panel, db, selectKey);
    RedisView.instances.set(view.registryKey, view);
    return view;
  }

  /** 按 (conn,panel) 查找实例（测试/复用）。 */
  static find(connId: string, panel: RedisPanel): RedisView | undefined {
    return RedisView.instances.get(`${connId}:${panel}`);
  }

  /** 关闭所有面板（测试隔离/扩展停用）。 */
  static closeAll(): void {
    for (const view of [...RedisView.instances.values()]) view.dispose();
    RedisView.instances.clear();
    RedisView.auditOwners.clear();
  }

  protected async handleMessage(msg: RedisUpMessage): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'redis' });
        return;
      }
      this.postConfig();
      await this.onReady();
      return;
    }
    if (msg.type === 'refreshInfo') { await this.pushInfo(); return; }
    if (msg.type === 'sampleMonitor') { if (this.panelType === 'monitor') await this.pushMonitor(); return; }
    if (msg.type === 'refreshSlowlog') { await this.pushSlowlog(); return; }
    if (msg.type === 'runCommand') { await this.runCommand(String(msg.id ?? ''), String(msg.line ?? '')); return; }
    if (msg.type === 'confirmDanger') { await this.resolveConfirm(String(msg.id ?? ''), msg.accept === true); return; }
    if (msg.type === 'selectKey') { await this.enqueuePushValue(String(msg.key ?? '')); return; }
    if (msg.type === 'load') { await this.forceLoadValue(String(msg.key ?? '')); return; }
    if (msg.type === 'saveString') { await this.edit('SET', String(msg.key), async (c) => { this.assertBinaryFree(String(msg.key)); await redisSet(c, String(msg.key), String(msg.value ?? '')); }); return; }
    if (msg.type === 'saveStringBytes') { await this.saveStringBytes(msg); return; }
    if (msg.type === 'appendString') { await this.edit('APPEND', String(msg.key), async (c) => { this.assertBinaryFree(String(msg.key)); await redisAppend(c, String(msg.key), String(msg.value ?? '')); }); return; }
    if (msg.type === 'setTtl') { await this.edit('EXPIRE', String(msg.key), async (c) => { this.assertBinaryFree(String(msg.key)); const s = Number(msg.seconds); if (!Number.isInteger(s) || s <= 0) throw new Error(l10n('cmd.redis.ttlInvalid')); await redisExpire(c, String(msg.key), s); }); return; }
    if (msg.type === 'persistKey') { await this.edit('PERSIST', String(msg.key), async (c) => { this.assertBinaryFree(String(msg.key)); await redisPersist(c, String(msg.key)); }); return; }
    if (msg.type === 'renameKey') { await this.renameKey(String(msg.key), String(msg.newKey ?? '')); return; }
    if (msg.type === 'deleteKeys') { await this.deleteKeys(Array.isArray(msg.keys) ? msg.keys.map(String) : []); return; }
    if (msg.type === 'hashSet') {
      const hkey = String(msg.key);
      const field = String(msg.field ?? '');
      const oldField = msg.oldField === undefined ? undefined : String(msg.oldField);
      const renaming = !!oldField && oldField !== field;
      this.assertBinaryFree(hkey, [...(oldField ? [field, oldField] : [field]), String(msg.value ?? '')]);
      await this.edit(renaming ? 'HSET+HDEL' : 'HSET', hkey, async (c) => {
        // 改名时目标 field 已存在则拒绝，避免静默覆盖（HSET 会直接覆盖值）。
        if (renaming && await redisHExists(c, hkey, field)) throw new Error(l10n('cmd.redis.fieldExists'));
        await redisHSet(c, hkey, field, String(msg.value ?? ''));
        // 非原子：HSET 已生效后 HDEL 失败会残留新旧两个 field（Redis 无原子改名）；失败也留痕。
        if (renaming) {
          try {
            await redisHDel(c, hkey, [oldField!]);
          } catch (err) {
            this.audit(`HSET ${field} (HDEL ${oldField} failed)`, hkey);
            throw err;
          }
        }
      });
      return;
    }
    if (msg.type === 'hashDel') {
      const fields = strs(msg.fields);
      this.assertBinaryFree(String(msg.key), fields);
      await this.edit('HDEL', String(msg.key), async (c) => redisHDel(c, String(msg.key), fields));
      return;
    }
    if (msg.type === 'listPush') { await this.edit('LPUSH/RPUSH', String(msg.key), async (c) => { const v = strs(msg.values); if (msg.side === 'left') await redisLPush(c, String(msg.key), v); else await redisRPush(c, String(msg.key), v); }); return; }
    if (msg.type === 'listSet') {
      // 并发保护：确认该下标当前值与用户看到的旧值一致，否则拒绝（他端改动会使下标移动）。
      await this.edit('LSET', String(msg.key), async (c) => {
        const key = String(msg.key);
        const index = Number(msg.index);
        const next = String(msg.value ?? '');
        this.assertBinaryFree(key, [String(msg.original ?? '')]);
        const current = await redisLIndex(c, key, index);
        if (current !== String(msg.original ?? '')) throw new Error(l10n('cmd.redis.listChanged'));
        await redisLSet(c, key, index, next);
      });
      return;
    }
    if (msg.type === 'listRem') {
      // 精确删「第 index 个元素」：LREM count=0 会删掉所有同值元素。用唯一标记替换该下标再 LREM 1，
      // 失败则回滚标记（避免污染列表）。
      await this.edit('LREM', String(msg.key), async (c) => {
        const key = String(msg.key);
        const index = Number(msg.index);
        const original = String(msg.value ?? '');
        this.assertBinaryFree(key, [original]);
        // 并发保护：确认该下标的当前值与用户看到的旧值一致，否则拒绝（他端可能已改动使下标移动）。
        const current = await redisLIndex(c, key, index);
        if (current !== original) throw new Error(l10n('cmd.redis.listChanged'));
        const marker = `\u0000devbelt:del:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        await redisLSet(c, key, index, marker);
        try {
          return await redisLRem(c, key, 1, marker);
        } catch (err) {
          try { await redisLSet(c, key, index, original); } catch { /* 标记残留可被下次编辑覆盖 */ }
          throw err;
        }
      });
      return;
    }
    if (msg.type === 'listTrim') { await this.edit('LTRIM', String(msg.key), async (c) => { await redisLTrim(c, String(msg.key), Number(msg.start), Number(msg.stop)); }); return; }
    if (msg.type === 'listPop') { await this.edit('LPOP/RPOP', String(msg.key), async (c) => { if (msg.side === 'left') await redisLPop(c, String(msg.key)); else await redisRPop(c, String(msg.key)); }); return; }
    if (msg.type === 'setAdd') { await this.edit('SADD', String(msg.key), async (c) => { await redisSAdd(c, String(msg.key), strs(msg.members)); }); return; }
    if (msg.type === 'setRem') {
      const members = strs(msg.members);
      this.assertBinaryFree(String(msg.key), members);
      await this.edit('SREM', String(msg.key), async (c) => redisSRem(c, String(msg.key), members));
      return;
    }
    if (msg.type === 'zsetAdd') {
      const zkey = String(msg.key);
      const member = String(msg.member ?? '');
      const oldMember = msg.oldMember === undefined ? undefined : String(msg.oldMember);
      const renaming = !!oldMember && oldMember !== member;
      this.assertBinaryFree(zkey, oldMember ? [member, oldMember] : [member]);
      await this.edit(renaming ? 'ZADD+ZREM' : 'ZADD', zkey, async (c) => {
        // 改名时目标 member 已存在则拒绝，避免静默覆盖。
        if (renaming && await redisZScore(c, zkey, member) !== null) throw new Error(l10n('cmd.redis.memberExists'));
        await redisZAdd(c, zkey, String(msg.score ?? '0'), member);
        // 非原子：ZADD 已生效后 ZREM 失败会残留新旧两个 member（Redis 无原子改名）；失败也留痕。
        if (renaming) {
          try {
            await redisZRem(c, zkey, [oldMember!]);
          } catch (err) {
            this.audit(`ZADD ${member} (ZREM ${oldMember} failed)`, zkey);
            throw err;
          }
        }
      });
      return;
    }
    if (msg.type === 'zsetRem') {
      const members = strs(msg.members);
      this.assertBinaryFree(String(msg.key), members);
      await this.edit('ZREM', String(msg.key), async (c) => redisZRem(c, String(msg.key), members));
      return;
    }
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
    this.disposed = true;
    this.logUnsub?.();
    this.logUnsub = undefined;
    // 移除会话 client 上的连接/故障切换监听器：否则面板关闭后仍会持续 post 消息。
    if (this.boundClient?.off) {
      for (const { ev, handler } of this.boundEvents) this.boundClient.off(ev, handler);
    }
    this.boundEvents.length = 0;
    this.boundClient = undefined;
    RedisView.instances.delete(this.registryKey);
    // 审计责任交接：若本实例是 owner，从剩余同连接实例中提升一位继承。
    if (RedisView.auditOwners.get(this.conn.id) === this) {
      RedisView.auditOwners.delete(this.conn.id);
      for (const [key, other] of RedisView.instances) {
        if (other !== this && key.startsWith(`${this.conn.id}:`)) {
          RedisView.auditOwners.set(this.conn.id, other);
          break;
        }
      }
    }
    this.manager.release(this.conn.id);
  }

  // ────────────────────────── 会话 ──────────────────────────

  /** 下发 config（按面板）。 */
  private postConfig(): void {
    this.post({
      type: 'config',
      connName: this.conn.name || this.conn.host,
      host: this.conn.host,
      port: this.conn.port,
      db: (this.panelType === 'keyBrowser' || this.panelType === 'console')
        ? (this.db ?? this.conn.redisDb ?? 0)
        : null,
      readOnly: this.conn.readOnly === true,
      connMode: this.conn.redisMode ?? 'standalone',
      panel: this.panelType,
      commands: allCommandNames(),
    });
  }

  /** 面板首次就绪后的初始拉取与订阅。 */
  private async onReady(): Promise<void> {
    const session = await this.manager.connect(this.conn);
    if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
    // 命令日志/连接事件订阅：任一面板打开即建立（断线审计依赖此）。
    this.ensureSubscriptions(session);
    if (this.panelType === 'keyBrowser') {
      // 值面板：无键树，仅按 initialKey（树点键）加载值；否则空态等用户从树选键。
      const k = this.initialKey;
      this.initialKey = undefined;
      if (k) await this.enqueuePushValue(k);
      return;
    }
if (this.panelType === 'serverStatus') { await this.pushInfo(); return; }
    if (this.panelType === 'console') {
      // 打开控制台即把共享会话归一到目标库（conn.redisDb），避免上一个键浏览器的
      // SELECT 泄漏到后续 CLI 命令（命令执行前也会再归一，这里是即时性保障）。
      await this.enqueue(async () => { await this.sessionForDb(); });
      return;
    }
    // commandLog 无需初始拉取（靠订阅推送）。
  }

  /** 切换 db（keyBrowser/console 已有实例时）：重发 config，按面板重载。 */
  private async reconfigure(): Promise<void> {
    // 不在此吞掉 pendingConfirm：保留后在 resolveConfirm 里按 db 漂移拒绝并给出提示
    // （直接清空会让用户点了确认却毫无反馈）。
    this.postConfig();
    if (this.panelType === 'keyBrowser') {
      const k = this.initialKey;
      this.initialKey = undefined;
      if (k) await this.enqueuePushValue(k);
      return;
    }
    if (this.panelType === 'console') { await this.enqueue(async () => { await this.sessionForDb(); }); return; }
  }

  /** 跨面板串行（SELECT + 命令原子）：走共享 client 的 runExclusive。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // 互斥粒度是 client 实例：若 manager.connect 因故重建了会话（新 client 自带新
    // opChain），在途旧 op 与新 op 不再互斥——但旧 op 必失败、实际无害，属已知豁口。
    return this.manager.connect(this.conn).then((session) => {
      if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
      return session.client.runExclusive(fn);
    });
  }

  private targetDb(): number {
    return this.db ?? this.conn.redisDb ?? 0;
  }

  private async sessionForDb(): Promise<RedisConnectionSession> {
    const session = await this.manager.connect(this.conn);
    if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
    // 无论本视图是否绑定 DB 节点，都把共享会话归一到确定目标：否则上一视图的
    // SELECT 会泄漏到连接级面板（UI/审计写 db0，命令却落在旧库）。
    // Cluster 无 SELECT，跳过（键按 slot 路由）。
    const target = this.targetDb();
    if (!session.client.isCluster && target !== session.db) {
      await redisSelect(session.client, target);
      session.db = target;
    }
    // 订阅连接/故障切换事件 + 命令日志。
    this.ensureSubscriptions(session);
    return session;
  }

  /** 订阅命令日志与连接/故障切换事件（幂等，每实例一次）。 */
  private ensureSubscriptions(session: RedisConnectionSession): void {
    if (!this.eventsBound && typeof session.client.on === 'function') {
      this.eventsBound = true;
      this.boundClient = session.client as unknown as RedisView['boundClient'];
      // 审计责任：首绑者负责；每面板仍互发 connectionEvent（各自 banner 用）。
      if (!RedisView.auditOwners.has(this.conn.id)) RedisView.auditOwners.set(this.conn.id, this);
      for (const ev of ['connect', 'ready', 'reconnecting', 'end', 'close', 'error']) {
        const handler = (...args: unknown[]): void => {
          if (this.disposed) return;
          const detail = args.length && args[0] != null ? String(args[0]) : null;
          this.post({ type: 'connectionEvent', event: ev, detail, at: Date.now() });
          if ((ev === 'reconnecting' || ev === 'end') && RedisView.auditOwners.get(this.conn.id) === this) {
            AuditLogger.tryLog({
              action: 'redis_command',
              connName: this.conn.name || this.conn.host,
              database: String(this.db ?? this.conn.redisDb ?? 0),
              sql: `connection:${ev}`,
            });
          }
        };
        session.client.on(ev, handler);
        this.boundEvents.push({ ev, handler });
      }
    }
    // 命令日志仅由 commandLog 面板订阅（其它面板不渲染它，避免 fan-out）。
    if (!this.logUnsub && this.panelType === 'commandLog' && typeof session.client.addLogListener === 'function') {
      this.logUnsub = session.client.addLogListener((entry) => {
        if (this.disposed) return;
        this.post({
          type: 'commandLog',
          entry: { command: entry.command, args: entry.args, durationMs: entry.durationMs, ok: entry.ok, error: entry.error ?? null },
        });
      });
    }
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

  /** 监控面板单次采样：INFO → 解析 → 回 monitorSample（cluster 逐 master 聚合）。 */
  private async pushMonitor(): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
      const client = session.client;
      const metrics = client.isCluster
        ? aggregateRedisInfo(await Promise.all(client.nodes().map(async (n) => parseRedisInfo(await redisInfoOnNode(n)))))
        : parseRedisInfo(await client.info());
      this.post({ type: 'monitorSample', metrics });
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

  // ────────────────────────── 值查看/编辑 ──────────────────────────

  /** 外部（树侧写操作后）刷新当前值（键树已在 explorer）。 */
  reloadKeys(): void {
    if (this.panelType !== 'keyBrowser') return;
    const k = this.lastKey;
    if (k) void this.enqueuePushValue(k);
  }

  private async enqueuePushValue(key: string): Promise<void> {
    this.lastKey = key;
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
      this.recordBinary(key, data);
      this.post({ type: 'value', key, keyType, ttl, tooLarge, size, data, keyBinary: this.keyBinary, binaryFields: [...this.binaryTokens] });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  /** 记录当前键/值中解码有损的部分（H5）：键名及 hash/set/zset/list 的字段/成员/元素。 */
  private recordBinary(key: string, data: RedisValueData | null): void {
    this.keyBinary = hasReplacement(key);
    this.binaryTokens = new Set<string>();
    if (!data) return;
    if (data.kind === 'hash') {
      // field 与 value 都有损都进只读集：编辑草稿会带 U+FFFD，原样保存会用有损文本覆盖原值。
      for (const [f, v] of data.entries) {
        if (hasReplacement(f)) this.binaryTokens.add(f);
        if (hasReplacement(v)) this.binaryTokens.add(v);
      }
    } else if (data.kind === 'set') {
      for (const m of data.members) if (hasReplacement(m)) this.binaryTokens.add(m);
    } else if (data.kind === 'zset') {
      for (const [m] of data.items) if (hasReplacement(m)) this.binaryTokens.add(m);
    } else if (data.kind === 'list') {
      for (const v of data.items) if (hasReplacement(v)) this.binaryTokens.add(v);
    }
  }

  /** H5 fail-closed：二进制键/成员禁止任何写操作（有损文本回写会破坏数据）。 */
  private assertBinaryFree(key: string, tokens: readonly string[] = []): void {
    // 只按本次操作涉及的 key/成员判断（不能用面板级 this.keyBinary，否则会误拦其它键）。
    if (hasReplacement(key)) throw new Error(l10n('cmd.redis.binaryReadOnly'));
    for (const t of tokens) if (hasReplacement(t) || this.binaryTokens.has(t)) throw new Error(l10n('cmd.redis.binaryReadOnly'));
  }

  /** 大 key「加载」：用户显式请求，绕过大小门禁强制加载一次。 */
  private async forceLoadValue(key: string): Promise<void> {
    if (!key) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const c = session.client;
        const keyType = await redisType(c, key);
        const ttl = await redisTtl(c, key);
        const size = keyType === 'string' ? await redisStrlen(c, key) : await redisMemoryUsage(c, key);
        // string 超过硬上限：只取 1MB 预览（GETRANGE），避免整值进内存并同时生成 text+base64 导致宿主/面板 OOM。
        if (keyType === 'string' && size !== null && size > FORCE_LOAD_MAX_BYTES) {
          const buf = await redisGetRangeBuffer(c, key, 0, LARGE_KEY_BYTES - 1);
          const data: RedisValueData = {
            kind: 'string',
            text: buf.toString('utf8'),
            base64: buf.toString('base64'),
            binary: !isValidUtf8(buf),
            bytes: buf.length,
          };
          this.recordBinary(key, data);
          this.post({ type: 'value', key, keyType, ttl, tooLarge: false, size, data, truncated: true, keyBinary: this.keyBinary, binaryFields: [...this.binaryTokens] });
          return;
        }
        const data = await this.loadValue(c, key, keyType);
        this.recordBinary(key, data);
        this.post({ type: 'value', key, keyType, ttl, tooLarge: false, size, data, keyBinary: this.keyBinary, binaryFields: [...this.binaryTokens] });
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
    });
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

  /** 执行一次键编辑并刷新值；失败回 keyAction error。`fn` 返回删除计数时，为 0 视为失败。 */
  private async edit(action: string, key: string, fn: (c: RedisCommandSource) => Promise<number | void>): Promise<void> {
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const started = Date.now();
        const affected = await fn(session.client);
        // H5：删除类命令返回 0 说明目标不存在（键名/成员有损或已被改动），不能谎报成功。
        if (typeof affected === 'number' && affected === 0) throw new Error(l10n('cmd.redis.deleteNoMatch'));
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
        // H5：键名有损（非 UTF-8）时不能按文本删；返回 0 也不能谎报成功。
        for (const k of keys) this.assertBinaryFree(k);
        // UNLINK：异步回收，避免大集合删除阻塞 Redis 主线程。
        const unlinked = await redisUnlink(session.client, keys);
        if (!unlinked) throw new Error(l10n('cmd.redis.deleteNoMatch'));
        this.audit('UNLINK', keys.join(' '), Date.now() - started);
        this.post({ type: 'keyAction', action: 'UNLINK', ok: true, error: null });
        // 键树在 explorer；面板仅同步当前值（删的若是当前键则转为空态）。
        if (this.lastKey && keys.includes(this.lastKey)) await this.doPushValue(session, this.lastKey);
      } catch (err) {
        this.post({ type: 'keyAction', action: 'UNLINK', ok: false, error: (err as Error).message });
      }
    });
  }

  // ────────────────────────── CLI（S2） ──────────────────────────

  private async runCommand(id: string, line: string): Promise<void> {
    if (!REDIS_CAPABILITIES.cli) {
      this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.cliUnsupported') });
      return;
    }
    let parts: (string | Buffer)[];
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
    const name = String(parts[0]).toUpperCase();
    const args = parts.slice(1);
    if (isDangerousCommand(name, args)) {
      // 记录确认时的目标 db：确认期间若切换了 db，破坏性命令不能落到新的库。
      this.pendingConfirm = { id, line, name, args, db: this.targetDb() };
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
    if (this.targetDb() !== pending.db) {
      // db 已切换：拒绝执行，避免「看到 db0 却删到 db3」。
      this.post({ type: 'commandResult', id, command: pending.line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.dbChanged') });
      return;
    }
    await this.execute(pending.id, pending.line, pending.name, pending.args);
  }

  private async execute(id: string, line: string, name: string, args: (string | Buffer)[]): Promise<void> {
    await this.enqueue(async () => {
      const started = Date.now();
      try {
        const session = await this.sessionForDb();
        // CLI 禁止 SELECT：面板/树/审计都按「本视图绑定的 db」工作，CLI 里换库会与它们分裂
        // （下一条命令进 sessionForDb 又会 select 回原库，破坏性命令落到错库）。用 DB 切换器换库。
        if (name.toLowerCase() === 'select') {
          this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: l10n('cmd.redis.selectDisabled') });
          return;
        }
        // 会改变/阻塞共享连接状态的命令一律拒绝：CLI 共享一条连接，这些会污染其它面板。
        const argsStr = args.map((a) => (Buffer.isBuffer(a) ? a.toString('latin1') : a));
        if (isCliBlocked(name, argsStr)) {
          this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: l10n('cmd.redis.connStateBlocked', { cmd: name.toUpperCase() }) });
          return;
        }
        const hasBuffer = args.some((a) => Buffer.isBuffer(a));
        const raw = hasBuffer
          ? await session.client.sendCommandBuffer(name, args as (string | number | Buffer)[])
          : await session.client.sendCommand(name, args as (string | number)[]);
        const costMs = Date.now() - started;
        if (isWriteCommand(name, argsStr) || isDangerousCommand(name, argsStr)) {
          // 审计只记命令 + key（首参），**不记值**；EVAL 只记脚本长度（脚本文本可能含字面值）。
          const detail = /^EVAL(_RO)?$/i.test(name) ? `len=${String(argsStr[0] ?? '').length}` : String(argsStr[0] ?? '');
          this.audit(name, detail, costMs);
        }
        this.post({ type: 'commandResult', id, command: line, ok: true, result: formatRedisReply(raw), costMs, error: null });
      } catch (err) {
        this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: (err as Error).message });
      }
    });
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
        this.assertBinaryFree(key, [newKey]);
        const session = await this.sessionForDb();
        if (await redisExists(session.client, newKey)) {
          this.post({ type: 'keyAction', action: 'RENAME', ok: false, error: l10n('cmd.redis.renameTargetExists') });
          return;
        }
        const started = Date.now();
        await redisRename(session.client, key, newKey);
        this.audit('RENAME', key, Date.now() - started);
        this.post({ type: 'keyAction', action: 'RENAME', ok: true, error: null });
        await this.doPushValue(session, newKey);
        this.lastKey = newKey;
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

/** CLI 中会改变/阻塞共享连接状态的命令（阻止污染其它面板）。 */
const CLI_BLOCKED_COMMANDS = new Set([
  'RESET', 'QUIT', 'AUTH', 'HELLO', 'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH',
  'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR',
  'BLPOP', 'BRPOP', 'BLMOVE', 'BRPOPLPUSH', 'BZPOPMIN', 'BZPOPMAX', 'BZMPOP', 'BLMPOP',
  // 阻塞/改变共享连接状态或阻塞服务端：
  'WAIT', 'WAITAOF', 'READONLY', 'READWRITE', 'SYNC', 'PSYNC',
]);

function isCliBlocked(name: string, args: readonly string[]): boolean {
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
  if (c === 'DEBUG' && upper[0] === 'SLEEP') return true;
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
