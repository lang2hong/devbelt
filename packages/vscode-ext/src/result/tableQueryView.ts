import * as vscode from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { getWebviewHtml } from '../webview/html';

/**
 * 表/查询视图：Vue 3 webview 模式。
 *
 * 扩展侧职责：SQL 执行、分页/排序/过滤 SQL 构建、内联 UPDATE、批量 DELETE。
 * Vue 侧职责：UI 渲染、用户交互（postMessage 通信）。
 */
export class TableQueryView {
  private static current?: TableQueryView;
  private readonly panel: vscode.WebviewPanel;
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
    this.hasTable = !!table;
    this.panel = vscode.window.createWebviewPanel(
      'dbclient.tableQuery',
      table ? `${conn.name || conn.host} › ${database || ''} › ${table}` : `Query @ ${conn.name || conn.host}`,
      viewColumn,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = getWebviewHtml(this.panel.webview, this._extensionUri);
    this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.panel.onDidDispose(() => { if (TableQueryView.current === this) TableQueryView.current = undefined; });
  }

  private static _extensionUri: vscode.Uri;
  static init(extensionUri: vscode.Uri): void { TableQueryView._extensionUri = extensionUri; }

  static open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager): void {
    if (TableQueryView.current) TableQueryView.current.panel.dispose();
    const view = new TableQueryView(conn, manager, table, database, undefined, vscode.ViewColumn.Active);
    TableQueryView.current = view;
  }

  static openForQuery(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    onExecuted?: (result: any, error?: Error) => void,
  ): TableQueryView {
    if (TableQueryView.current) TableQueryView.current.panel.dispose();
    const view = new TableQueryView(conn, manager, undefined, undefined, sql, vscode.ViewColumn.Beside);
    view.onExecuted = onExecuted;
    TableQueryView.current = view;
    return view;
  }

  renderExternal(result: any): void {
    void this.panel.webview.postMessage({ type: 'result', result, pkColumns: [] });
  }

  showError(message: string): void {
    void this.panel.webview.postMessage({ type: 'error', message });
  }

  private get _extensionUri(): vscode.Uri { return TableQueryView._extensionUri; }

  /** 安全转义 LIKE 值：处理 `'` `\` `%` `_` */
  private escapeLike(val: string): string {
    const escaped = val.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_');
    return `'${escaped}%'`;
  }

  private async sendInit(): Promise<void> {
    void this.panel.webview.postMessage({
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

  private async runInitial(): Promise<void> {
    if (!this.hasTable) return;
    const sql = this.buildSelect();
    if (sql) await this.execute(sql);
  }

  private async handleMessage(msg: any): Promise<void> {
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

  private async execute(sql: string): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
      let result: any;
      for (const stmt of stmts) result = await session.query.query(stmt);
      let pkCols: string[] = [];
      if (this.hasTable && this.table) {
        try {
          const cols = await session.metadata.getColumns(this.table, this.database);
          pkCols = cols.filter((c) => c.isPrimary).map((c) => c.name);
        } catch {}
      }
      void this.panel.webview.postMessage({ type: 'result', result, pkColumns: pkCols });
      this.onExecuted?.(result);
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
      this.onExecuted?.(undefined, err as Error);
    }
  }

  private async updateCell(pkCol: string, rowId: any, col: string, val: string): Promise<void> {
    try {
      const session = await this.manager.connect(this.conn);
      await session.data.updateCell(this.table!, pkCol, rowId, col, val === '' ? null : val, this.database);
      void this.panel.webview.postMessage({ type: 'cellUpdated' });
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
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
      void this.panel.webview.postMessage({ type: 'rowsDeleted', count: rows.length });
      await this.execute(this.buildSelect());
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: (err as Error).message });
    }
  }
}
