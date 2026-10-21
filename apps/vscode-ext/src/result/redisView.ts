import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import {
  redisType, redisSelect, redisGetBuffer, redisGetRangeBuffer, redisStrlen, redisSet, redisSetBuffer, redisAppend,
  isValidUtf8, isBufferSource,
  redisUnlink, redisExists, redisRename, redisTtl, redisExpire, redisPersist, redisMemoryUsage,
  redisHSet, redisHDel, redisHLen, redisHExists, redisHScanBuffer, redisHDelBuffer, redisHSetBuffer,
  redisLLen, redisLPush, redisRPush, redisLSet, redisLRem, redisLTrim, redisLPop, redisRPop, redisLIndex,
  redisLRangeBuffer, redisLIndexBuffer, redisLSetBuffer,
  redisSCard, redisSAdd, redisSRem,
  redisSScanBuffer, redisSRemBuffer,
  redisZCard, redisZAdd, redisZRem, redisZScore, allCommandNames,
  redisZRangeBuffer, redisZRemBuffer, redisZAddBuffer,
  redisXLen, redisXInfoGroups,
  redisXRangeBuffer,
  redisInfoOnNode,
  type RedisCommandSource,
} from '@devbelt/db-core';
import type { RedisConnectionSession } from '../connection/connectionSession';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';
import type { RedisPanel, RedisValueData, RedisUpMessage, RedisMoreToken, RedisCollectionKind } from './protocol';
import { parseRedisInfo, aggregateRedisInfo } from './redisInfoParse';
import { RedisCliConsole } from './redisCliConsole';
import { RedisStreamOps } from './redisStreamOps';
import type { RedisOpsHost } from './redisViewSupport';
import {
  FORCE_LOAD_MAX_BYTES, HASH_SET_PAGE, LARGE_KEY_BYTES, STREAM_PAGE,
  hasReplacement, strs, parseSlowlog,
  redisPanelTitle, redisViewType,
} from './redisViewSupport';

// 纯函数从支撑模块转发（保持既有导入路径：测试直接 import 这些名字）。
export { formatRedisReply, parseSlowlog, redisAuditLine } from './redisViewSupport';

/** list/zset 单页条数（offset 续页；与 hash/set 的 HASH_SET_PAGE 同量级）。 */
const LIST_ZSET_PAGE = 200;

/** Stage B（3C-1）：字节项 → 文本（有损显示）+ base64（精确字节）+ 是否有损。 */
function bytesItemOf(buf: Buffer): { text: string; b64: string; binary: boolean } {
  return { text: buf.toString('utf8'), b64: buf.toString('base64'), binary: !isValidUtf8(buf) };
}

/** 可选 base64 数组归一（与文本数组并行等长时使用）。 */
function bytesArrayOf(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(String) : undefined;
}

/**
 * Redis 面板（S5：按职责拆分为独立 webview）。
 *
 * 每个 (conn.id, panel) 维护一个实例（注册表），不再单例顶替；同连接的多个面板
 * 共享一条 session，`SELECT` 归一与命令经 `RedisClient.runExclusive` 串行（S5 并发隔离）。
 *
 * Phase 2 拆分：CLI 控制台（`RedisCliConsole`）与 Stream 操作（`RedisStreamOps`）
 * 经 `RedisOpsHost` 宿主面下沉到独立模块；本类保留会话/值查看编辑/消息编排。
 */
export class RedisView extends BaseWebView {
  private static readonly instances = new Map<string, RedisView>();
  /** `connection:*` 审计责任面板：每连接仅一个实例负责写（避免多面板重复）。 */
  private static readonly auditOwners = new Map<string, RedisView>();

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
  /** webview 已挂载（收到第二次 ready）：此前不 post value，避免 reload 竞态丢消息。 */
  private webviewReady = false;
  /** ready 前要推送的 value 消息（单槽，保留最新）。 */
  private pendingValueMsg: unknown | null = null;
  /** ready 前缓存的「外部注入控制台命令」（如 AI Chat 面板运行）。 */
  private pendingConsoleLines: string[] = [];
  /** H5：当前键名解码含替换符（非 UTF-8）→ 只读。 */
  private keyBinary = false;
  /** H5：当前值里解码含替换符的字段/成员/元素 → 这些项只读（防有损回写）。 */
  private binaryTokens = new Set<string>();

  /** CLI 控制台子逻辑（待确认状态在子模块内）。 */
  private readonly cli: RedisCliConsole;
  /** Stream 操作子逻辑。 */
  private readonly streams: RedisStreamOps;

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
    const host: RedisOpsHost = {
      enqueue: (fn) => this.enqueue(fn),
      sessionForDb: () => this.sessionForDb(),
      post: (msg) => this.post(msg as never),
      audit: (command, detail, costTime) => this.audit(command, detail, costTime),
      doPushValue: (session, key) => this.doPushValue(session, key),
      targetDb: () => this.targetDb(),
    };
    this.cli = new RedisCliConsole(host);
    this.streams = new RedisStreamOps(host);
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

  /** S7i：外部（AI Chat「在面板运行」）注入控制台命令；webview 未就绪时缓存、就绪后补发。 */
  runConsoleLines(lines: string[]): void {
    const cleaned = lines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (cleaned.length === 0) return;
    if (this.webviewReady) {
      this.post({ type: 'cliInject', lines: cleaned } as never);
      return;
    }
    this.pendingConsoleLines.push(...cleaned);
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
        // 新一轮 webview 加载：ready 前禁止直接 post，避免重载窗口期值消息丢失。
        this.webviewReady = false;
        this.post({ type: 'init', mode: 'redis' });
        return;
      }
      this.webviewReady = true;
      this.postConfig();
      await this.onReady();
      // 补发 ready 前缓存的 value（reload 时值消息可能早于 handler 挂载）。
      if (this.pendingValueMsg) { const p = this.pendingValueMsg; this.pendingValueMsg = null; this.post(p as never); }
      if (this.pendingConsoleLines.length > 0) {
        const lines = this.pendingConsoleLines.splice(0);
        this.post({ type: 'cliInject', lines } as never);
      }
      return;
    }
    if (msg.type === 'refreshInfo') { await this.pushInfo(); return; }
    if (msg.type === 'sampleMonitor') { if (this.panelType === 'monitor') await this.pushMonitor(); return; }
    if (msg.type === 'refreshSlowlog') { await this.pushSlowlog(); return; }
    if (msg.type === 'runCommand') { await this.cli.runCommand(String(msg.id ?? ''), String(msg.line ?? '')); return; }
    if (msg.type === 'confirmDanger') { await this.cli.resolveConfirm(String(msg.id ?? ''), msg.accept === true); return; }
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
      const valueBase64 = typeof msg.valueBase64 === 'string' ? msg.valueBase64 : undefined;
      const fieldBase64 = typeof msg.fieldBase64 === 'string' ? msg.fieldBase64 : undefined;
      const oldField = msg.oldField === undefined ? undefined : String(msg.oldField);
      const renaming = !!oldField && oldField !== field;
      // Stage B（3C-2）：值按精确字节写入（field 可文本或字节）；二进制 field 的改名不在支持面（fail-closed）。
      if (valueBase64 !== undefined) {
        if (renaming) {
          this.post({ type: 'keyAction', action: 'HSET', ok: false, error: l10n('cmd.redis.binaryReadOnly') });
          return;
        }
        await this.edit('HSET', hkey, async (c) => {
          const fieldBuf = fieldBase64 !== undefined ? Buffer.from(fieldBase64, 'base64') : Buffer.from(field, 'utf8');
          await redisHSetBuffer(c, hkey, fieldBuf, Buffer.from(valueBase64, 'base64'));
        });
        return;
      }
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
      // Stage B：webview 提供精确字节（与 fields 并行等长）时按字节删除；否则保持文本路径。
      const fieldsBase64 = bytesArrayOf(msg.fieldsBase64);
      if (fieldsBase64 && fieldsBase64.length === fields.length) {
        const bufs = fieldsBase64.map((b) => Buffer.from(b, 'base64'));
        await this.edit('HDEL', String(msg.key), async (c) => redisHDelBuffer(c, String(msg.key), bufs));
        return;
      }
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
        const valueBase64 = typeof msg.valueBase64 === 'string' ? msg.valueBase64 : undefined;
        const originalBase64 = typeof msg.originalBase64 === 'string' ? msg.originalBase64 : undefined;
        // Stage B（3C-2）：二进制元素按精确字节比对 + 回写（缺任一侧则回退文本路径）。
        if (valueBase64 !== undefined && originalBase64 !== undefined) {
          const expected = Buffer.from(originalBase64, 'base64');
          const current = await redisLIndexBuffer(c, key, index);
          if (!current || !current.equals(expected)) throw new Error(l10n('cmd.redis.listChanged'));
          await redisLSetBuffer(c, key, index, Buffer.from(valueBase64, 'base64'));
          return;
        }
        const next = String(msg.value ?? '');
        this.assertBinaryFree(key, [String(msg.original ?? '')]);
        const current = await redisLIndex(c, key, index);
        if (current !== String(msg.original ?? '')) throw new Error(l10n('cmd.redis.listChanged'));
        await redisLSet(c, key, index, next);
      });
      return;
    }
    if (msg.type === 'listRem') {
      const valueBase64 = typeof msg.valueBase64 === 'string' ? msg.valueBase64 : undefined;
      // Stage B：二进制元素按精确字节比对/删除（标记法保留并发保护；回滚回原始字节）。
      if (valueBase64 !== undefined) {
        await this.edit('LREM', String(msg.key), async (c) => {
          const key = String(msg.key);
          const index = Number(msg.index);
          const expected = Buffer.from(valueBase64, 'base64');
          const current = await redisLIndexBuffer(c, key, index);
          if (!current || !current.equals(expected)) throw new Error(l10n('cmd.redis.listChanged'));
          const marker = `\u0000devbelt:del:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
          await redisLSet(c, key, index, marker);
          try {
            return await redisLRem(c, key, 1, marker);
          } catch (err) {
            try { await redisLSetBuffer(c, key, index, expected); } catch { /* 标记残留可被下次编辑覆盖 */ }
            throw err;
          }
        });
        return;
      }
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
      const membersBase64 = bytesArrayOf(msg.membersBase64);
      if (membersBase64 && membersBase64.length === members.length) {
        const bufs = membersBase64.map((b) => Buffer.from(b, 'base64'));
        await this.edit('SREM', String(msg.key), async (c) => redisSRemBuffer(c, String(msg.key), bufs));
        return;
      }
      this.assertBinaryFree(String(msg.key), members);
      await this.edit('SREM', String(msg.key), async (c) => redisSRem(c, String(msg.key), members));
      return;
    }
    if (msg.type === 'zsetAdd') {
      const zkey = String(msg.key);
      const member = String(msg.member ?? '');
      const memberBase64 = typeof msg.memberBase64 === 'string' ? msg.memberBase64 : undefined;
      const oldMember = msg.oldMember === undefined ? undefined : String(msg.oldMember);
      const renaming = !!oldMember && oldMember !== member;
      // Stage B（3C-2）：二进制 member 按精确字节改 score；改名不在支持面（fail-closed）。
      if (memberBase64 !== undefined) {
        if (renaming) {
          this.post({ type: 'keyAction', action: 'ZADD', ok: false, error: l10n('cmd.redis.binaryReadOnly') });
          return;
        }
        await this.edit('ZADD', zkey, async (c) => {
          await redisZAddBuffer(c, zkey, String(msg.score ?? '0'), Buffer.from(memberBase64, 'base64'));
        });
        return;
      }
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
      const membersBase64 = bytesArrayOf(msg.membersBase64);
      if (membersBase64 && membersBase64.length === members.length) {
        const bufs = membersBase64.map((b) => Buffer.from(b, 'base64'));
        await this.edit('ZREM', String(msg.key), async (c) => redisZRemBuffer(c, String(msg.key), bufs));
        return;
      }
      this.assertBinaryFree(String(msg.key), members);
      await this.edit('ZREM', String(msg.key), async (c) => redisZRem(c, String(msg.key), members));
      return;
    }
    if (msg.type === 'streamAdd') { await this.streams.streamAdd(msg); return; }
    if (msg.type === 'streamDel') { await this.streams.streamDelOp(msg); return; }
    if (msg.type === 'streamTrim') { await this.streams.streamTrimOp(msg); return; }
    if (msg.type === 'streamGroupCreate') { await this.streams.streamGroupCreateOp(msg); return; }
    if (msg.type === 'streamGroupDestroy') { await this.streams.streamGroupDestroyOp(msg); return; }
    if (msg.type === 'streamGroupDelConsumer') { await this.streams.streamGroupDelConsumerOp(msg); return; }
    if (msg.type === 'streamGroupDetail') { await this.streams.streamGroupDetailOp(msg); return; }
    if (msg.type === 'streamAck') { await this.streams.streamAckOp(msg); return; }
    if (msg.type === 'streamClaim') { await this.streams.streamClaimOp(msg); return; }
    if (msg.type === 'streamRange') { await this.streams.streamRangeOp(msg); return; }
    if (msg.type === 'collectionMore') { await this.collectionMoreOp(msg); return; }
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
      // 值面板：优先 initialKey（树点键），重载后回退 lastKey，避免面板空白。
      const k = this.initialKey ?? this.lastKey;
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
      const loaded: { data: RedisValueData | null; more?: RedisMoreToken } = tooLarge
        ? { data: null }
        : await this.loadValue(c, key, keyType);
      this.recordBinary(key, loaded.data);
      const valueMsg = { type: 'value', key, keyType, ttl, tooLarge, size, data: loaded.data, more: loaded.more, keyBinary: this.keyBinary, binaryFields: [...this.binaryTokens] };
      // webview 未挂载时缓存（否则 post 丢失，reload 后看不到值）。
      if (!this.webviewReady) this.pendingValueMsg = valueMsg;
      else this.post(valueMsg as never);
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
        const loaded = await this.loadValue(c, key, keyType);
        this.recordBinary(key, loaded.data);
        this.post({ type: 'value', key, keyType, ttl, tooLarge: false, size, data: loaded.data, more: loaded.more, keyBinary: this.keyBinary, binaryFields: [...this.binaryTokens] });
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
    });
  }

  private async loadValue(c: RedisCommandSource, key: string, keyType: string): Promise<{ data: RedisValueData | null; more?: RedisMoreToken }> {
    switch (keyType) {
      case 'string': {
        const buf = await redisGetBuffer(c, key);
        return {
          data: {
            kind: 'string',
            text: buf ? buf.toString('utf8') : '',
            base64: buf ? buf.toString('base64') : '',
            binary: buf ? !isValidUtf8(buf) : false,
            bytes: buf ? buf.length : 0,
          },
        };
      }
      case 'hash': {
        // 分页兜底：MEMORY USAGE 不可用/大 key 时也不全量 HGETALL；cursor 供续页。
        // Stage B：字节级读取；存在二进制项时附并行 base64（webview 精确展示/删除）。
        const page = await redisHScanBuffer(c, key, 0, { count: HASH_SET_PAGE });
        const len = await redisHLen(c, key);
        const items = page.entries.map(([f, v]) => ({ f: bytesItemOf(f), v: bytesItemOf(v) }));
        const binary = items.some((x) => x.f.binary || x.v.binary);
        return {
          data: {
            kind: 'hash',
            entries: items.map((x) => [x.f.text, x.v.text] as [string, string]),
            len,
            ...(binary ? { entryBytes: items.map((x) => [x.f.b64, x.v.b64] as [string, string]) } : {}),
          },
          more: { cursor: page.cursor, done: page.cursor === '0' },
        };
      }
      case 'list': {
        const bufs = await redisLRangeBuffer(c, key, 0, LIST_ZSET_PAGE - 1);
        const items = bufs.map(bytesItemOf);
        const binary = items.some((x) => x.binary);
        return {
          data: {
            kind: 'list',
            items: items.map((x) => x.text),
            len: await redisLLen(c, key),
            ...(binary ? { itemBytes: items.map((x) => x.b64) } : {}),
          },
          more: { offset: items.length, done: items.length < LIST_ZSET_PAGE },
        };
      }
      case 'set': {
        const page = await redisSScanBuffer(c, key, 0, { count: HASH_SET_PAGE });
        const items = page.keys.map(bytesItemOf);
        const binary = items.some((x) => x.binary);
        return {
          data: {
            kind: 'set',
            members: items.map((x) => x.text),
            card: await redisSCard(c, key),
            ...(binary ? { memberBytes: items.map((x) => x.b64) } : {}),
          },
          more: { cursor: page.cursor, done: page.cursor === '0' },
        };
      }
      case 'zset': {
        const bufs = await redisZRangeBuffer(c, key, 0, LIST_ZSET_PAGE - 1);
        const items = bufs.map(({ member, score }) => ({ m: bytesItemOf(member), score }));
        const binary = items.some((x) => x.m.binary);
        return {
          data: {
            kind: 'zset',
            items: items.map((x) => [x.m.text, x.score] as [string, string]),
            card: await redisZCard(c, key),
            ...(binary ? { itemBytes: items.map((x) => [x.m.b64, x.score] as [string, string]) } : {}),
          },
          more: { offset: items.length, done: items.length < LIST_ZSET_PAGE },
        };
      }
      case 'stream': {
        // Stage B：字节级 XRANGE；存在二进制 field/value 时按条附并行 base64。
        const entries = (await redisXRangeBuffer(c, key, '-', '+', STREAM_PAGE)).map((e) => {
          const fields = e.fields.map(([f, v]) => ({ f: bytesItemOf(f), v: bytesItemOf(v) }));
          const binary = fields.some((x) => x.f.binary || x.v.binary);
          return {
            id: e.id,
            fields: fields.map((x) => [x.f.text, x.v.text] as [string, string]),
            ...(binary ? { fieldBytes: fields.map((x) => [x.f.b64, x.v.b64] as [string, string]) } : {}),
          };
        });
        return {
          data: {
            kind: 'stream',
            entries,
            len: await redisXLen(c, key),
            groups: await redisXInfoGroups(c, key),
          },
        };
      }
      default: return { data: null };
    }
  }

  /** 集合续页（hash/set 按 SCAN 游标；list/zset 按 offset）。只读，不写审计。 */
  private async collectionMoreOp(msg: { key?: unknown; kind?: unknown; cursor?: unknown; offset?: unknown }): Promise<void> {
    const key = String(msg.key ?? '');
    const kind = String(msg.kind ?? '') as RedisCollectionKind;
    if (!key || !['hash', 'list', 'set', 'zset'].includes(kind)) return;
    await this.enqueue(async () => {
      try {
        const session = await this.sessionForDb();
        const c = session.client;
        if (kind === 'hash') {
          const page = await redisHScanBuffer(c, key, String(msg.cursor ?? '0'), { count: HASH_SET_PAGE });
          const items = page.entries.map(([f, v]) => ({ f: bytesItemOf(f), v: bytesItemOf(v) }));
          const binary = items.some((x) => x.f.binary || x.v.binary);
          this.post({
            type: 'collectionMoreResult', key, kind,
            entries: items.map((x) => [x.f.text, x.v.text] as [string, string]),
            ...(binary ? { entryBytes: items.map((x) => [x.f.b64, x.v.b64] as [string, string]) } : {}),
            more: { cursor: page.cursor, done: page.cursor === '0' },
          });
        } else if (kind === 'set') {
          const page = await redisSScanBuffer(c, key, String(msg.cursor ?? '0'), { count: HASH_SET_PAGE });
          const items = page.keys.map(bytesItemOf);
          const binary = items.some((x) => x.binary);
          this.post({
            type: 'collectionMoreResult', key, kind,
            members: items.map((x) => x.text),
            ...(binary ? { memberBytes: items.map((x) => x.b64) } : {}),
            more: { cursor: page.cursor, done: page.cursor === '0' },
          });
        } else if (kind === 'list') {
          const offset = Math.max(0, Number(msg.offset ?? 0) || 0);
          const bufs = await redisLRangeBuffer(c, key, offset, offset + LIST_ZSET_PAGE - 1);
          const items = bufs.map(bytesItemOf);
          const binary = items.some((x) => x.binary);
          this.post({
            type: 'collectionMoreResult', key, kind,
            items: items.map((x) => x.text),
            ...(binary ? { itemBytes: items.map((x) => x.b64) } : {}),
            more: { offset: offset + items.length, done: items.length < LIST_ZSET_PAGE },
          });
        } else {
          const offset = Math.max(0, Number(msg.offset ?? 0) || 0);
          const bufs = await redisZRangeBuffer(c, key, offset, offset + LIST_ZSET_PAGE - 1);
          const items = bufs.map(({ member, score }) => ({ m: bytesItemOf(member), score }));
          const binary = items.some((x) => x.m.binary);
          this.post({
            type: 'collectionMoreResult', key, kind,
            items: items.map((x) => [x.m.text, x.score] as [string, string]),
            ...(binary ? { itemBytes: items.map((x) => [x.m.b64, x.score] as [string, string]) } : {}),
            more: { offset: offset + items.length, done: items.length < LIST_ZSET_PAGE },
          });
        }
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
    });
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
    // 校验 base64：旧版 webview 可能发来非法串，Buffer.from(...,'base64') 会**静默损坏字节**。
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new Error('invalid base64 payload');
    }
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