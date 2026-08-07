import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import type { SavedConnection } from '../connection/connectionStore';

/**
 * 终端集成：按数据库类型打开 CLI。
 *
 * 安全：密码通过环境变量传递（MYSQL_PWD / PGPASSWORD），不在命令行暴露。
 *
 * 设计模式：策略模式（按 dbType 选择 CLI + 参数构造）
 */
export class TerminalService {
  /** 打开数据库 CLI 终端 */
  static open(conn: SavedConnection): void {
    const cmd = TerminalService.buildCommand(conn);
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

  /** 构造 CLI 命令 + 环境变量 */
  private static buildCommand(conn: SavedConnection): { cmd: string; env: Record<string, string> } | undefined {
    switch (conn.dbType) {
      case DatabaseType.MYSQL:
        return {
          cmd: `mysql -u ${conn.user} -h ${conn.host} -P ${conn.port} ${conn.database ? conn.database : ''}`,
          env: conn.password ? { MYSQL_PWD: conn.password } : {},
        };
      case DatabaseType.PG:
        return {
          cmd: `psql -U ${conn.user} -h ${conn.host} -p ${conn.port} ${conn.database ? conn.database : ''}`,
          env: conn.password ? { PGPASSWORD: conn.password } : {},
        };
      case DatabaseType.SQLITE:
        return {
          cmd: `sqlite3 ${conn.dbPath || ''}`,
          env: {},
        };
      default:
        return undefined;
    }
  }
}
