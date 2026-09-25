import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { isDangerousCommand, isWriteCommand, redactCommandArgs, splitRedisArgs } from '@devbelt/db-core';
import type { RedisConnectionSession } from '../connection/connectionSession';
import { ConnectionManager } from '../connection/connectionManager';
import { REDIS_CAPABILITIES } from '../connection/redisCapabilities';
import { BaseWebView } from './baseWebView';
import { AuditLogger } from '../utils/auditLogger';
import { l10n } from '../i18n';
import type { RedisSlowlogEntry, RedisTab } from './protocol';

/** Redis 面板（P7 S2）：Status / CLI / SlowLog 三个标签页。 */
export class RedisView extends BaseWebView {
  private static current?: RedisView;
  private pendingConfirm?: { id: string; line: string; name: string; args: string[] };

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly initialTab: RedisTab,
  ) {
    super('devbelt.redis', `Redis @ ${conn.name || conn.host}`);
    this.manager.retain(conn.id);
  }

  static open(conn: SavedConnection, manager: ConnectionManager, tab: RedisTab = 'status'): void {
    if (RedisView.current) RedisView.current.dispose();
    RedisView.current = new RedisView(conn, manager, tab);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        // 第一次 ready 来自 App.vue 默认 QueryView：只发 init 切到 redis 模式，
        // 等 RedisView.vue 挂载后再推配置与数据，避免在监听器注册前发送丢失。
        this.initSent = true;
        this.post({ type: 'init', mode: 'redis' });
        return;
      }
      // 第二次 ready 来自 RedisView.vue 挂载：先发连接配置，再推数据。
      this.post({
        type: 'config',
        connName: this.conn.name || this.conn.host,
        host: this.conn.host,
        port: this.conn.port,
        db: this.conn.redisDb ?? 0,
        readOnly: this.conn.readOnly === true,
        connMode: 'standalone',
        redisTab: this.initialTab,
      });
      await this.pushInfo();
      await this.pushSlowlog();
      return;
    }
    if (msg.type === 'refreshInfo') { await this.pushInfo(); return; }
    if (msg.type === 'refreshSlowlog') { await this.pushSlowlog(); return; }
    if (msg.type === 'runCommand') { await this.runCommand(String(msg.id ?? ''), String(msg.line ?? '')); return; }
    if (msg.type === 'confirmDanger') { await this.resolveConfirm(String(msg.id ?? ''), msg.accept === true); return; }
  }

  protected onDispose(): void {
    super.onDispose();
    if (RedisView.current === this) RedisView.current = undefined;
    this.manager.release(this.conn.id);
  }

  /** 取活跃 Redis 会话（不存在或已死则重建）。 */
  private async redisSession(): Promise<RedisConnectionSession> {
    const session = await this.manager.connect(this.conn);
    if (session.kind !== 'redis') throw new Error('connection is not a Redis session');
    return session;
  }

  private async pushInfo(): Promise<void> {
    try {
      const session = await this.redisSession();
      this.post({ type: 'info', info: await session.client.info() });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async pushSlowlog(): Promise<void> {
    try {
      const session = await this.redisSession();
      const raw = await session.client.sendCommand('SLOWLOG', ['GET', '128']);
      this.post({ type: 'slowlog', entries: parseSlowlog(raw) });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  /** 控制台执行：切分 → 危险命令确认 → 发送。只读拦截在 RedisClient 切面。 */
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
      const session = await this.redisSession();
      const raw = await session.client.sendCommand(name, args);
      const costMs = Date.now() - started;
      // 审计只记写/危险命令（读命令会淹没审计），与 P7 §6.6 对齐；
      // 参数经 redactCommandArgs 脱敏（P7 §十：日志禁止明文密码）。
      if (isWriteCommand(name, args) || isDangerousCommand(name, args)) {
        AuditLogger.tryLog({
          action: 'redis_command',
          connName: this.conn.name || this.conn.host,
          database: String(session.db),
          sql: redisAuditLine(name, args),
          costTime: costMs,
        });
      }
      this.post({ type: 'commandResult', id, command: line, ok: true, result: formatRedisReply(raw), costMs, error: null });
    } catch (err) {
      this.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: (err as Error).message });
    }
  }
}

/**
 * 审计行文本（P7 §十：日志禁止明文密码）。
 *
 * 复用 db-core 的 `redactCommandArgs`：AUTH 整段、CONFIG SET / ACL SETUSER 的值脱敏，
 * 其余参数截断。CLI 看到的原始命令仍由 `commandResult.command` 原样回显（仅 UI）。
 */
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
