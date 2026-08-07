import * as vscode from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { getWebviewHtml } from '../webview/html';

/**
 * ER 图视图：展示表关系图（SVG 渲染）。
 * 查询表+列+外键，推送到 Vue 组件渲染。
 */
export class ERDiagramView {
  private static current?: ERDiagramView;
  private readonly panel: vscode.WebviewPanel;
  private static _extensionUri: vscode.Uri;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly database: string,
    private readonly manager: ConnectionManager,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dbclient.erDiagram',
      `ER Diagram @ ${database}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = getWebviewHtml(this.panel.webview, ERDiagramView._extensionUri);
    this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.panel.onDidDispose(() => { if (ERDiagramView.current === this) ERDiagramView.current = undefined; });
  }

  static init(extensionUri: vscode.Uri): void { ERDiagramView._extensionUri = extensionUri; }

  static open(conn: SavedConnection, database: string, manager: ConnectionManager): void {
    if (ERDiagramView.current) ERDiagramView.current.panel.dispose();
    const view = new ERDiagramView(conn, database, manager);
    ERDiagramView.current = view;
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.type !== 'ready') return;
    try {
      const session = await this.manager.connect(this.conn);
      const [tables, foreignKeys] = await Promise.all([
        session.metadata.getTables(this.database),
        session.metadata.getForeignKeys(this.database),
      ]);
      const tableData = await Promise.all(
        tables.map(async (t) => ({
          name: t.name,
          columns: (await session.metadata.getColumns(t.name, this.database)).map((c) => ({
            name: c.name,
            type: c.simpleType || c.type || '',
            isPK: c.isPrimary,
          })),
        })),
      );
      void this.panel.webview.postMessage({ type: 'data', tables: tableData, foreignKeys });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
    }
  }
}
