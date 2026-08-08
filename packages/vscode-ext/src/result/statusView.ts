import * as vscode from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { getWebviewHtml } from '../webview/html';

/**
 * Server 状态面板：展示进程列表、状态变量、服务器变量。
 * 通过 Vue3 webview 渲染，扩展侧负责数据查询。
 */
export class StatusView {
  private static current?: StatusView;
  private readonly panel: vscode.WebviewPanel;
  private static _extensionUri: vscode.Uri;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dbclient.serverStatus',
      `Status @ ${conn.name || conn.host}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = getWebviewHtml(this.panel.webview, StatusView._extensionUri);
    const msgDisp = this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      msgDisp.dispose();
      if (StatusView.current === this) StatusView.current = undefined;
    });
  }

  static init(extensionUri: vscode.Uri): void { StatusView._extensionUri = extensionUri; }

  static open(conn: SavedConnection, manager: ConnectionManager): void {
    if (StatusView.current) StatusView.current.panel.dispose();
    const view = new StatusView(conn, manager);
    StatusView.current = view;
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.type !== 'ready') return;
    try {
      const session = await this.manager.connect(this.conn);
      const [processList, statusVars, serverVars] = await Promise.all([
        session.metadata.getProcessList(),
        session.metadata.getStatusVariables(),
        session.metadata.getServerVariables(),
      ]);
      void this.panel.webview.postMessage({ type: 'data', processList, statusVars, serverVars });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
    }
  }
}
