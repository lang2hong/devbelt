import * as vscode from 'vscode';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { ConnectionStore } from '@devkit/db-host/connection/connectionStore';

/**
 * 连接上下文跟踪器（参考 database-client 的 getByActiveFile + activeNode）。
 *
 * 策略：
 *  1. per-editor Map：SQL 编辑器按 URI 关联连接+数据库
 *  2. workspaceState：持久化最后活跃连接（跨重启）
 *  3. getForDoc(uri)：仅返回文档显式绑定的连接，避免多连接时串库
 */
export class ConnectionContext {
  private readonly editorMap = new Map<string, { connId: string; db?: string }>();
  private readonly savedQueryMap = new WeakMap<vscode.TextDocument, string>();
  private readonly wsKey = 'devbelt.lastConn';

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

  /** 获取文档关联的连接。未绑定的文档必须由调用方要求用户选择连接。 */
  getForDoc(uri: string): { conn: SavedConnection; db?: string } | undefined {
    const entry = this.editorMap.get(uri);
    if (entry) {
      const conn = this.store.get(entry.connId);
      if (conn) return { conn, db: entry.db };
    }
    return undefined;
  }

  clearForDoc(uri: string): void {
    this.editorMap.delete(uri);
  }

  /** Associate an open document with the saved query it edits. */
  setSavedQueryForDoc(document: vscode.TextDocument, queryId: string): void {
    this.savedQueryMap.set(document, queryId);
  }

  /** Return the saved query edited by this document, if any. */
  getSavedQueryForDoc(document: vscode.TextDocument): string | undefined {
    return this.savedQueryMap.get(document);
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
