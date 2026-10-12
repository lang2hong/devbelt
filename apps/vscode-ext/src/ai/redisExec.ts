import * as vscode from 'vscode';
import { isDangerousCommand, isWriteCommand, redisSelect, splitRedisArgs } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { RedisConnectionSession } from '../connection/connectionSession.js';
import { formatRedisReply, isCliBlocked, redisAuditLine } from '../result/redisViewSupport.js';
import { AuditLogger } from '../utils/auditLogger.js';
import { l10n } from '../i18n';

/**
 * AI 生成的 Redis 命令执行桥（P9 S7b）。
 *
 * 红线与 CLI 控制台同构：
 *  - **用户点击才执行**（本模块只被面板执行按钮调用，AI 永不自动执行）；
 *  - 由 `runExclusive` 串行：SELECT 归一 + 整批命令原子（与键浏览器/控制台的面板事务互斥）；
 *  - SELECT / 连接态命令（`isCliBlocked`）一律阻断——换库由面板作用域选择器管理；
 *  - 含写/危险命令（`isWriteCommand`/`isDangerousCommand`）先弹模态确认（列出全部命令）；
 *  - 只读连接由客户端切面兜底（写命令抛 `RedisReadOnlyError`）；
 *  - 写/危险命令逐条写审计（沿用 CLI：命令 + 首参 key，EVAL 只记脚本长度）。
 */
const MAX_RESULT_CHARS = 2000;

export interface RedisToolResult {
  title: string;
  content: string;
  isError: boolean;
}

export interface RedisExecDeps {
  /** 写/危险命令确认（返回 true 才执行）；测试注入桩。 */
  confirm: (commands: string[]) => Promise<boolean>;
}

interface ParsedCommand {
  line: string;
  name: string;
  args: (string | Buffer)[];
  argsStr: string[];
}

/** 默认确认：模态警告，列出批次命令（写/危险命令执行前的唯一闸门，host 侧）。 */
export async function defaultConfirm(commands: string[]): Promise<boolean> {
  const label = l10n('ai.redis.confirmRun');
  const picked = await vscode.window.showWarningMessage(
    l10n('ai.redis.confirm', { n: commands.length, list: commands.slice(0, 10).join('\n') }),
    { modal: true },
    label,
  );
  return picked === label;
}

export async function executeRedisCommands(
  conn: SavedConnection,
  session: RedisConnectionSession,
  lines: string[],
  db: number,
  deps: RedisExecDeps = { confirm: defaultConfirm },
): Promise<RedisToolResult> {
  const title = l10n('ai.redis.title', { db, n: lines.length });

  const parsed: ParsedCommand[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    let parts: (string | Buffer)[];
    try {
      parts = splitRedisArgs(line);
    } catch (err) {
      return { title, content: l10n('ai.redis.parseFailed', { line, error: (err as Error).message }), isError: true };
    }
    if (parts.length === 0) continue;
    const name = String(parts[0]).toUpperCase();
    const args = parts.slice(1);
    parsed.push({
      line,
      name,
      args,
      argsStr: args.map((a) => (Buffer.isBuffer(a) ? a.toString('latin1') : String(a))),
    });
  }
  if (parsed.length === 0) return { title, content: l10n('ai.redis.empty'), isError: true };

  const blocked = new Set(
    parsed.filter((c) => c.name === 'SELECT' || isCliBlocked(c.name, c.argsStr)).map((c) => c.line),
  );
  const runnable = parsed.filter((c) => !blocked.has(c.line));
  const hasWrite = runnable.some((c) => isWriteCommand(c.name, c.argsStr) || isDangerousCommand(c.name, c.argsStr));
  if (hasWrite && !(await deps.confirm(parsed.map((c) => c.line)))) {
    return { title, content: l10n('ai.redis.cancelled'), isError: false };
  }

  const out: string[] = [];
  let failed = blocked.size > 0;
  await session.client.runExclusive(async () => {
    if (!session.client.isCluster && session.db !== db) {
      await redisSelect(session.client, db);
      session.db = db;
    }
    for (const command of parsed) {
      if (blocked.has(command.line)) {
        out.push(`$ ${command.line}\n${l10n('ai.redis.blocked')}`);
        continue;
      }
      const started = Date.now();
      try {
        const hasBuffer = command.args.some((a) => Buffer.isBuffer(a));
        const raw = hasBuffer
          ? await session.client.sendCommandBuffer(command.name, command.args as (string | number | Buffer)[])
          : await session.client.sendCommand(command.name, command.args as (string | number)[]);
        out.push(`$ ${command.line}\n${truncate(formatRedisReply(raw))}`);
        if (isWriteCommand(command.name, command.argsStr) || isDangerousCommand(command.name, command.argsStr)) {
          const detail = /^EVAL(_RO)?$/i.test(command.name)
            ? `len=${String(command.argsStr[0] ?? '').length}`
            : String(command.argsStr[0] ?? '');
          AuditLogger.tryLog({
            action: 'redis_command',
            connName: conn.name || conn.host,
            database: String(db),
            sql: redisAuditLine(command.name, [detail].filter(Boolean)),
            costTime: Date.now() - started,
          });
        }
      } catch (err) {
        failed = true;
        out.push(`$ ${command.line}\n${l10n('ai.redis.error', { error: (err as Error).message })}`);
      }
    }
  });
  return { title, content: out.join('\n\n'), isError: failed };
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(${text.length - MAX_RESULT_CHARS} chars truncated)` : text;
}