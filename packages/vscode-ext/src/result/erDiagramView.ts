import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';

export class ERDiagramView extends BaseWebView {
  private static current?: ERDiagramView;

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

  protected async handleMessage(msg: any): Promise<void> {
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
      this.post({ type: 'data', tables: tableData, foreignKeys });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (ERDiagramView.current === this) ERDiagramView.current = undefined;
  }
}
