import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';

export class ERDiagramView extends BaseWebView {
  private static current?: ERDiagramView;

  /** 见 handleMessage 的两次-ready 协议 */
  private initSent = false;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly database: string,
    private readonly manager: ConnectionManager,
  ) {
    super('dbclient.erDiagram', `ER Diagram @ ${database}`);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static open(conn: SavedConnection, database: string, manager: ConnectionManager): void {
    if (ERDiagramView.current) ERDiagramView.current.dispose();
    const view = new ERDiagramView(conn, database, manager);
    ERDiagramView.current = view;
  }

  /**
   * 两次-ready 协议（与 statusView/dashboardView 等一致）。
   *
   * App.vue 默认挂载 QueryView，第一次 ready 来自它；此时只回 `init{mode:'er'}`
   * 把视图切到 ER 分支。等 ERDiagramView.vue 挂载并注册监听后会再发一次 ready，
   * 那时才推 `data`——否则 data 在监听器注册前发出，直接丢弃，面板会一直停在空 SQL 编辑器。
   */
  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type !== 'ready') return;
    if (!this.initSent) {
      this.initSent = true;
      this.post({ type: 'init', mode: 'er' });
      return;
    }
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
      this.post({ type: 'data', tables: tableData, foreignKeys });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (ERDiagramView.current === this) ERDiagramView.current = undefined;
    if (!this.manager.isExplicit(this.conn.id)) {
      this.manager.disposeConn(this.conn.id);
    }
  }
}
