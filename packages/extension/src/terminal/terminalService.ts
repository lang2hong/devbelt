import * as vscode from 'vscode';
import { DatabaseType } from '@devkit/core';
import type { SavedConnection } from '../connection/connectionStore';

/**
 * 按平台引用 shell 参数。
 *
 * POSIX：`'...'`，内嵌 `'` 用 `'\''`。
 * Windows：VS Code 默认 shell 是 PowerShell，单引号内为字面量（内嵌 `'` 用 `''`）。
 * 但若值含 cmd 元字符（`& | < > ^ % ! "`），在用户把默认 shell 配成 cmd 时单引号
 * 并不防护 —— 此时 **fail-closed 拒绝**，而不是拼出可注入的命令行。
 */
function shellQuote(value: unknown): string {
  const s = String(value ?? '');
  if (process.platform === 'win32') {
    if (/[&|<>^%!"]/.test(s)) {
      throw new Error('Value contains characters that are unsafe to quote for a Windows shell.');
    }
    return `'${s.replace(/'/g, "''")}'`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 终端集成：按数据库类型打开 CLI。
 *
 * 安全：密码通过环境变量传递（MYSQL_PWD / PGPASSWORD），不在命令行暴露。
 *
 * 设计模式：策略模式（按 dbType 选择 CLI + 参数构造）
 */
export class TerminalService {
  /** 打开数据库 CLI 终端 */
  static open(conn: SavedConnection, database?: string): void {
    const db = database || conn.database;
    let cmd: { cmd: string; env: Record<string, string> } | undefined;
    try {
      cmd = TerminalService.buildCommand(conn, db);
    } catch (err) {
      vscode.window.showWarningMessage(`Terminal not supported: ${(err as Error).message}`);
      return;
    }
    if (!cmd) {
      vscode.window.showWarningMessage(`Terminal not supported for ${conn.dbType}`);
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: conn.name || conn.host,
      env: cmd.env,
      cwd: undefined,
    });
    terminal.show();
    terminal.sendText(cmd.cmd);
  }

  static buildCommand(conn: SavedConnection, database?: string): { cmd: string; env: Record<string, string> } | undefined {
    switch (conn.dbType) {
      case DatabaseType.MYSQL:
        return {
          cmd: `mysql -u ${shellQuote(conn.user)} -h ${shellQuote(conn.host)} -P ${shellQuote(String(conn.port ?? ''))} ${database ? shellQuote(database) : ''}`,
          env: conn.password ? { MYSQL_PWD: conn.password } : {},
        };
      case DatabaseType.PG:
        return {
          cmd: `psql -U ${shellQuote(conn.user)} -h ${shellQuote(conn.host)} -p ${shellQuote(String(conn.port ?? ''))} ${database ? shellQuote(database) : ''}`,
          env: conn.password ? { PGPASSWORD: conn.password } : {},
        };
      case DatabaseType.SQLITE:
        return {
          cmd: `sqlite3 ${shellQuote(conn.dbPath || '')}`,
          env: {},
        };
      default:
        return undefined;
    }
  }
}
