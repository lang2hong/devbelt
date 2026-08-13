import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { validateIdent } from '@db-client/core';

export class TableDesignView extends BaseWebView {
  private static current?: TableDesignView;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly table: string,
    private readonly database: string,
    private readonly manager: ConnectionManager,
    private readonly onMutate?: () => void,
  ) {
    super('dbclient.tableDesign', `Design: ${conn.name || conn.host} › ${database} › ${table}`);
  }

  static init(extensionUri: import('vscode').Uri): void { BaseWebView.init(extensionUri); }

  static async open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager, onMutate?: () => void): Promise<void> {
    if (TableDesignView.current) TableDesignView.current.dispose();
    const view = new TableDesignView(conn, table, database, manager, onMutate);
    TableDesignView.current = view;
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'ready') {
      this.post({ type: 'init', mode: 'design', dbType: this.conn.dbType });
      await this.loadData();
      return;
    }
    if (msg.type === 'addColumn') {
      this.validateDesignIdent(msg.column, 'column');
      this.validateDefinition(msg.definition, 'column');
      await this.mutate(`ALTER TABLE ${this.table} ADD COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.addColumn(this.table, msg.column, msg.definition, this.database);
      });
      return;
    }
    if (msg.type === 'dropColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} DROP COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.dropColumn(this.table, msg.column, this.database);
      });
      return;
    }
    if (msg.type === 'modifyColumn') {
      this.validateDesignIdent(msg.column, 'column');
      this.validateDefinition(msg.definition, 'column');
      await this.mutate(`ALTER TABLE ${this.table} MODIFY COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.modifyColumn(this.table, msg.column, msg.definition, this.database);
      });
      return;
    }
    if (msg.type === 'reorderColumn') {
      this.validateDesignIdent(msg.column, 'column');
      await this.mutate(`ALTER TABLE ${this.table} REORDER COLUMN ${msg.column}`, async () => {
        const session = await this.session();
        await session.table.reorderColumn(this.table, msg.column, msg.afterColumn ?? null, this.database);
      });
      return;
    }
    if (msg.type === 'addIndex') {
      this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`CREATE INDEX ${msg.name} ON ${this.table}`, async () => {
        const session = await this.session();
        await session.table.createIndex(msg.name, this.table, Array.isArray(msg.columns) ? msg.columns : [], this.database, !!msg.isUnique);
      });
      return;
    }
    if (msg.type === 'editIndex') {
      this.validateDesignIdent(msg.oldName, 'index');
      if (msg.name) this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`ALTER INDEX ${msg.oldName} ON ${this.table}`, async () => {
        const session = await this.session();
        const cols = Array.isArray(msg.columns) ? msg.columns : [];
        if (String(msg.oldName).toUpperCase() === 'PRIMARY') {
          await session.table.recreatePrimaryKey(this.table, cols, this.database);
        } else {
          await session.table.dropIndex(msg.oldName, this.table, this.database);
          await session.table.createIndex(msg.name, this.table, cols, this.database, !!msg.isUnique);
        }
      });
      return;
    }
    if (msg.type === 'dropIndex') {
      this.validateDesignIdent(msg.name, 'index');
      await this.mutate(`DROP INDEX ${msg.name} ON ${this.table}`, async () => {
        const session = await this.session();
        await session.table.dropIndex(msg.name, this.table, this.database);
      });
      return;
    }
  }

  private async session() {
    return this.manager.connect(this.conn);
  }

  private async mutate(op: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      if (!(await confirmSqlExecution(this.conn, op))) return;
      await fn();
      await this.loadData();
      this.onMutate?.();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private validateDesignIdent(name: string, context: string): void {
    if (!name || typeof name !== 'string') {
      throw new Error(`Invalid ${context} name`);
    }
    validateIdent(name);
  }

  private validateDefinition(def: string, context: string): void {
    if (!def || typeof def !== 'string' || def.length > 500) {
      throw new Error(`Invalid ${context} definition`);
    }
    if (/[;']/.test(def)) {
      throw new Error(`${context} definition contains invalid characters`);
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
    if (!this.manager.isExplicit(this.conn.id)) {
      this.manager.disposeConn(this.conn.id);
    }
  }
}
