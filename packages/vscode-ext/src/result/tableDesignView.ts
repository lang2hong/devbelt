import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';

export class TableDesignView extends BaseWebView {
  private static current?: TableDesignView;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly table: string,
    private readonly database: string,
    private readonly manager: ConnectionManager,
  ) {
    super('dbclient.tableDesign', `Design: ${conn.name || conn.host} › ${database} › ${table}`);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static async open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager): Promise<void> {
    if (TableDesignView.current) TableDesignView.current.dispose();
    const view = new TableDesignView(conn, table, database, manager);
    TableDesignView.current = view;
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      this.post({ type: 'init', mode: 'design' });
      await this.loadData();
      return;
    }
    if (msg.type === 'addColumn') {
      await this.mutate(async () => {
        const session = await this.session();
        await session.table.addColumn(this.table, msg.column, msg.definition, this.database);
      });
      return;
    }
    if (msg.type === 'dropColumn') {
      await this.mutate(async () => {
        const session = await this.session();
        await session.table.dropColumn(this.table, msg.column, this.database);
      });
      return;
    }
    if (msg.type === 'modifyColumn') {
      await this.mutate(async () => {
        const session = await this.session();
        await session.table.modifyColumn(this.table, msg.column, msg.definition, this.database);
      });
      return;
    }
  }

  private async session() {
    return this.manager.connect(this.conn);
  }

  private async mutate(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      await this.loadData();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async loadData(): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      const [columns, indexes, ddl] = await Promise.all([
        session.metadata.getColumns(this.table, this.database),
        session.metadata.getIndexes(this.table, this.database),
        session.table.getCreateSql(this.table, this.database),
      ]);
      this.post({ type: 'data', columns, indexes, ddl });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (TableDesignView.current === this) TableDesignView.current = undefined;
  }
}
