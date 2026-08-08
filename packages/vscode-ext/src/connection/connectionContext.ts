import * as vscode from 'vscode';
import type { SavedConnection } from './connectionStore';
import { ConnectionStore } from './connectionStore';

/**
 * 连接上下文跟踪器（参考 database-client 的 getByActiveFile + activeNode）。
 *
 * 策略：
 *  1. per-editor Map：SQL 编辑器按 URI 关联连接+数据库
 *  2. workspaceState：持久化最后活跃连接（跨重启）
 *  3. getForDoc(uri)：per-editor → workspaceState → undefined
 */
export class ConnectionContext {
  private readonly editorMap = new Map<string, { connId: string; db?: string }>();
  private readonly wsKey = 'dbclient.lastConn';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
  ) {}

  /** 关联编辑器文档与连接+数据库，同时更新 workspace 级别 */
  setForDoc(uri: string, conn: SavedConnection, db?: string): void {
    this.editorMap.set(uri, { connId: conn.id, db });
    this.setLast(conn, db);
  }

  /** 设置 workspace 级别最后活跃连接（持久化） */
  setLast(conn: SavedConnection, db?: string): void {
    void this.context.workspaceState.update(this.wsKey, { connId: conn.id, db });
  }

  /** 获取文档关联的连接：per-editor → workspaceState → undefined */
  getForDoc(uri: string): { conn: SavedConnection; db?: string } | undefined {
    const entry = this.editorMap.get(uri);
    if (entry) {
      const conn = this.store.get(entry.connId);
      if (conn) return { conn, db: entry.db };
    }
    return this.getLast();
  }

  /** 获取 workspace 级别最后活跃连接 */
  getLast(): { conn: SavedConnection; db?: string } | undefined {
    const ws = this.context.workspaceState.get<{ connId: string; db?: string }>(this.wsKey);
    if (!ws) return undefined;
    const conn = this.store.get(ws.connId);
    if (!conn) return undefined;
    return { conn, db: ws.db };
  }
}
