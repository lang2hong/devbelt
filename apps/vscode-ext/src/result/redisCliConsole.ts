/**
 * Redis CLI 控制台命令执行（从 `RedisView` 抽出，Phase 2 拆分）。
 *
 * 负责命令解析、危险命令二次确认、SELECT/连接态命令拦截、共享连接串行执行与审计。
 * 通过 `RedisOpsHost` 宿主面执行命令与回发消息；待确认状态（单槽）由本类持有。
 */
import { isDangerousCommand, isWriteCommand, splitRedisArgs } from '@devbelt/db-core';
import { REDIS_CAPABILITIES } from '../connection/redisCapabilities';
import { l10n } from '../i18n';
import type { RedisOpsHost } from './redisViewSupport';
import { formatRedisReply, isCliBlocked } from './redisViewSupport';

export class RedisCliConsole {
  private pendingConfirm?: { id: string; line: string; name: string; args: (string | Buffer)[]; db: number };

  constructor(private readonly host: RedisOpsHost) {}

  async runCommand(id: string, line: string): Promise<void> {
    if (!REDIS_CAPABILITIES.cli) {
      this.host.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.cliUnsupported') });
      return;
    }
    let parts: (string | Buffer)[];
    try {
      parts = splitRedisArgs(line);
    } catch (err) {
      this.host.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: (err as Error).message });
      return;
    }
    if (!parts.length) {
      this.host.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.emptyCommand') });
      return;
    }
    const name = String(parts[0]).toUpperCase();
    const args = parts.slice(1);
    if (isDangerousCommand(name, args)) {
      // 只有单个确认槽：已有待确认命令时不再覆盖（覆盖会让第一条的确认结果丢失）。
      if (this.pendingConfirm) {
        this.host.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.confirmPending') });
        return;
      }
      // 记录确认时的目标 db：确认期间若切换了 db，破坏性命令不能落到新的库。
      this.pendingConfirm = { id, line, name, args, db: this.host.targetDb() };
      this.host.post({ type: 'confirmRequired', id, command: line });
      return;
    }
    await this.execute(id, line, name, args);
  }

  async resolveConfirm(id: string, accept: boolean): Promise<void> {
    const pending = this.pendingConfirm;
    this.pendingConfirm = undefined;
    if (!pending || pending.id !== id) return;
    if (!accept) {
      this.host.post({ type: 'commandResult', id, command: pending.line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.dangerCancelled') });
      return;
    }
    if (this.host.targetDb() !== pending.db) {
      // db 已切换：拒绝执行，避免「看到 db0 却删到 db3」。
      this.host.post({ type: 'commandResult', id, command: pending.line, ok: false, result: '', costMs: 0, error: l10n('cmd.redis.dbChanged') });
      return;
    }
    await this.execute(pending.id, pending.line, pending.name, pending.args);
  }

  private async execute(id: string, line: string, name: string, args: (string | Buffer)[]): Promise<void> {
    await this.host.enqueue(async () => {
      const started = Date.now();
      try {
        const session = await this.host.sessionForDb();
        // CLI 禁止 SELECT：面板/树/审计都按「本视图绑定的 db」工作，CLI 里换库会与它们分裂
        // （下一条命令进 sessionForDb 又会 select 回原库，破坏性命令落到错库）。用 DB 切换器换库。
        if (name.toLowerCase() === 'select') {
          this.host.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: l10n('cmd.redis.selectDisabled') });
          return;
        }
        // 会改变/阻塞共享连接状态的命令一律拒绝：CLI 共享一条连接，这些会污染其它面板。
        const argsStr = args.map((a) => (Buffer.isBuffer(a) ? a.toString('latin1') : a));
        if (isCliBlocked(name, argsStr)) {
          this.host.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: l10n('cmd.redis.connStateBlocked', { cmd: name.toUpperCase() }) });
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
          this.host.audit(name, detail, costMs);
        }
        this.host.post({ type: 'commandResult', id, command: line, ok: true, result: formatRedisReply(raw), costMs, error: null });
      } catch (err) {
        this.host.post({ type: 'commandResult', id, command: line, ok: false, result: '', costMs: Date.now() - started, error: (err as Error).message });
      }
    });
  }
}