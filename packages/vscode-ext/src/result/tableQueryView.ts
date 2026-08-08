import * as vscode from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { splitSqlStatements } from '../utils/sql';

/**
 * 表/查询视图：Vue 3 webview 模式。
 */
export class TableQueryView extends BaseWebView {
  private static current?: TableQueryView;
  private offset = 0;
  private readonly limit = 100;
  private sortCol = '';
  private sortDir = '';
  private filterCol = '';
  private filterVal = '';
  private readonly hasTable: boolean;
  private onExecuted?: (result: any, error?: Error) => void;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly table: string | undefined,
    private readonly database: string | undefined,
    private readonly initialSql: string | undefined,
    viewColumn: vscode.ViewColumn,
  ) {
    super(
      'dbclient.tableQuery',
      table ? `${conn.name || conn.host} › ${database || ''} › ${table}` : `Query @ ${conn.name || conn.host}`,
      viewColumn,
    );
    this.hasTable = !!table;
  }

  static init(extensionUri: vscode.Uri): void { BaseWebView.init(extensionUri); }

  static open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager): void {
    if (TableQueryView.current) TableQueryView.current.dispose();
    const view = new TableQueryView(conn, manager, table, database, undefined, vscode.ViewColumn.Active);
    TableQueryView.current = view;
  }

  static openForQuery(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    onExecuted?: (result: any, error?: Error) => void,
  ): TableQueryView {
    if (TableQueryView.current) TableQueryView.current.dispose();
    const view = new TableQueryView(conn, manager, undefined, undefined, sql, vscode.ViewColumn.Beside);
    view.onExecuted = onExecuted;
    TableQueryView.current = view;
    return view;
  }

  renderExternal(result: any): void {
    this.post({ type: 'result', result, pkColumns: [] });
  }

  protected async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.sendInit();
        if (this.initialSql) {
          await this.execute(this.initialSql);
        } else if (this.hasTable) {
          await this.runInitial();
        }
        break;
      case 'run':
        this.sortCol = ''; this.sortDir = ''; this.filterCol = ''; this.filterVal = ''; this.offset = 0;
        await this.execute(msg.sql);
        break;
      case 'nextPage':
        this.offset += this.limit; await this.execute(this.buildSelect());
        break;
      case 'prevPage':
        this.offset = Math.max(0, this.offset - this.limit); await this.execute(this.buildSelect());
        break;
      case 'sort':
        if (!this.hasTable) return;
        if (this.sortCol === msg.column && this.sortDir === 'ASC') this.sortDir = 'DESC';
        else if (this.sortCol === msg.column && this.sortDir === 'DESC') { this.sortCol = ''; this.sortDir = ''; }
        else { this.sortCol = msg.column; this.sortDir = 'ASC'; }
        this.offset = 0; await this.execute(this.buildSelect());
        break;
      case 'filter':
        if (!this.hasTable) return;
        this.filterCol = msg.column || ''; this.filterVal = msg.value || '';
        this.offset = 0; await this.execute(this.buildSelect());
        break;
      case 'updateCell':
        if (!this.hasTable) return;
        await this.updateCell(msg.pkColumn, msg.rowId, msg.column, msg.value);
        break;
      case 'deleteRows':
        if (!this.hasTable) return;
        await this.deleteRows(msg.rows);
        break;
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (TableQueryView.current === this) TableQueryView.current = undefined;
  }

  private async sendInit(): Promise<void> {
    this.post({
      type: 'init',
      mode: 'query',
      initialSql: this.initialSql || this.buildSelect(),
      hasTable: this.hasTable,
      tableName: this.table || '',
      dbName: this.database || '',
    });
  }

  private buildSelect(): string {
    if (!this.hasTable || !this.table) return '';
    const w = this.conn.dbType === 'MYSQL' ? '`' : '"';
    const tbl = this.database
      ? `${w}${this.database}${w}.${w}${this.table}${w}`
      : `${w}${this.table}${w}`;
    let sql = `SELECT * FROM ${tbl}`;
    if (this.filterCol && this.filterVal) {
      sql += ` WHERE ${w}${this.filterCol}${w} LIKE ${this.escapeLike(this.filterVal)}`;
    }
    if (this.sortCol && this.sortDir) {
      sql += ` ORDER BY ${w}${this.sortCol}${w} ${this.sortDir}`;
    }
    sql += ` LIMIT ${this.limit} OFFSET ${this.offset}`;
    return sql;
  }

  private escapeLike(val: string): string {
    const escaped = val.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_');
    return `'${escaped}%'`;
  }

  private async runInitial(): Promise<void> {
    if (!this.hasTable) return;
    const sql = this.buildSelect();
    if (sql) await this.execute(sql);
  }

  private async execute(sql: string): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      const stmts = splitSqlStatements(sql);
      let result: any;
      for (const stmt of stmts) result = await session.query.query(stmt);
      let pkCols: string[] = [];
      if (this.hasTable && this.table) {
        try {
          const cols = await session.metadata.getColumns(this.table, this.database);
          pkCols = cols.filter((c) => c.isPrimary).map((c) => c.name);
        } catch {}
      }
      this.post({ type: 'result', result, pkColumns: pkCols });
      this.onExecuted?.(result);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
      this.onExecuted?.(undefined, err as Error);
    }
  }

  private async updateCell(pkCol: string, rowId: any, col: string, val: string): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      await session.data.updateCell(this.table!, pkCol, rowId, col, val === '' ? null : val, this.database);
      this.post({ type: 'cellUpdated' });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async deleteRows(rows: { pkColumn: string; pkValue: any }[]): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      const w = this.conn.dbType === 'MYSQL' ? '`' : '"';
      const table = this.database
        ? `${w}${this.database}${w}.${w}${this.table}${w}`
        : `${w}${this.table}${w}`;
      for (const r of rows) {
        const valEsc = r.pkValue === null ? 'NULL' : `'${String(r.pkValue).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
        await session.query.query(`DELETE FROM ${table} WHERE ${w}${r.pkColumn}${w} = ${valEsc}`);
      }
      this.post({ type: 'rowsDeleted', count: rows.length });
      await this.execute(this.buildSelect());
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }
}
