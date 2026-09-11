import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import type { SavedConnection } from '../connection/connectionStore';

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
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
    const cmd = TerminalService.buildCommand(conn, db);
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
