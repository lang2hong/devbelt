import * as vscode from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { getWebviewHtml } from '../webview/html';

/**
 * 表设计视图：Vue 3 webview 模式。
 * 三 Tab：Columns / Indexes / DDL。
 */
export class TableDesignView {
  private static current?: TableDesignView;
  private readonly panel: vscode.WebviewPanel;
  private static _extensionUri: vscode.Uri;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly table: string,
    private readonly database: string,
    private readonly manager: ConnectionManager,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dbclient.tableDesign',
      `Design: ${conn.name || conn.host} › ${database} › ${table}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = getWebviewHtml(this.panel.webview, TableDesignView._extensionUri);
    const msgDisp = this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      msgDisp.dispose();
      if (TableDesignView.current === this) TableDesignView.current = undefined;
    });
  }

  static init(extensionUri: vscode.Uri): void { TableDesignView._extensionUri = extensionUri; }

  static async open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager): Promise<void> {
    if (TableDesignView.current) TableDesignView.current.panel.dispose();
    const view = new TableDesignView(conn, table, database, manager);
    TableDesignView.current = view;
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.type !== 'ready') return;
    void this.panel.webview.postMessage({ type: 'init', mode: 'design' });
    try {
      const session = await this.manager.connect(this.conn);
      const [columns, indexes, ddl] = await Promise.all([
        session.metadata.getColumns(this.table, this.database),
        session.metadata.getIndexes(this.table, this.database),
        session.table.getCreateSql(this.table, this.database),
      ]);
      void this.panel.webview.postMessage({ type: 'data', columns, indexes, ddl });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
    }
  }
}
