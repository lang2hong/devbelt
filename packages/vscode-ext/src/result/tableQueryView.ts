import * as vscode from 'vscode';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { splitSqlStatements } from '../utils/sql';
import { confirmSqlExecution } from '../utils/sqlSafety';
import type { QueryService } from '@db-client/core';
import { validateIdent } from '@db-client/core';
import { TableProfileStore } from './tableProfileStore';
import { exportRows, type TransferFormat } from '../data/transfer/exportService';

/**
 * 表/查询视图：Vue 3 webview 模式。
 */
export class TableQueryView extends BaseWebView {
  private static readonly queryViews = new Map<string, TableQueryView>();
  private static profileStore?: TableProfileStore;
  private offset = 0;
  private readonly limit = 100;
  private sortCol = '';
  private sortDir = '';
  private filterCol = '';
  private filterVal = '';
  private hiddenColumns: string[] = [];
  private columnOrder: string[] = [];
  private columnWidths: Record<string, number> = {};
  private lastFields: string[] = [];
  private editablePkColumn?: string;
  private readonly hasTable: boolean;
  private runningQuery?: QueryService;
  private ready = false;
  private executingPendingQuery = false;
  private pendingQuery?: {
    sql: string;
    database?: string;
    onExecuted?: (result: any, error?: Error) => void;
  };

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly table: string | undefined,
    private database: string | undefined,
    viewColumn: vscode.ViewColumn,
  ) {
    super(
      'dbclient.tableQuery',
      table ? `${conn.name || conn.host} › ${database || ''} › ${table}` : `Query @ ${conn.name || conn.host}`,
      viewColumn,
    );
    this.hasTable = !!table;
    if (this.hasTable) {
      const saved = TableQueryView.profileStore?.get(conn.id, database, table!);
      if (saved) {
        this.sortCol = saved.sortCol || '';
        this.sortDir = saved.sortDir || '';
        this.filterCol = saved.filterCol || '';
        this.filterVal = saved.filterVal || '';
        this.hiddenColumns = saved.hiddenColumns || [];
        this.columnOrder = saved.columnOrder || [];
        this.columnWidths = saved.columnWidths || {};
      }
    }
  }

  static init(extensionUri: vscode.Uri, profileStore?: TableProfileStore): void {
    BaseWebView.init(extensionUri);
    TableQueryView.profileStore = profileStore;
  }

  static open(conn: SavedConnection, table: string, database: string, manager: ConnectionManager): void {
    new TableQueryView(conn, manager, table, database, vscode.ViewColumn.Active);
  }

  static openForQuery(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    database?: string,
    onExecuted?: (result: any, error?: Error) => void,
    mode: 'reuse' | 'new' = 'reuse',
  ): TableQueryView {
    const existing = mode === 'reuse' ? TableQueryView.queryViews.get(conn.id) : undefined;
    if (existing) {
      existing.queueQuery(sql, database, onExecuted);
      return existing;
    }
    const view = new TableQueryView(conn, manager, undefined, database, vscode.ViewColumn.Beside);
    TableQueryView.queryViews.set(conn.id, view);
    view.queueQuery(sql, database, onExecuted);
    return view;
  }

  renderExternal(result: any): void {
    this.post({ type: 'result', result, pkColumns: [] });
  }

  protected async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        if (this.pendingQuery) {
          await this.executePendingQueries();
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
        await this.persistProfile();
        break;
      case 'filter':
        if (!this.hasTable) return;
        this.filterCol = msg.column || ''; this.filterVal = msg.value || '';
        this.offset = 0; await this.execute(this.buildSelect());
        await this.persistProfile();
        break;
      case 'updateCell':
        if (!this.hasTable) return;
        await this.updateCell(msg.pkColumn, msg.rowId, msg.column, msg.value);
        break;
      case 'deleteRows':
        if (!this.hasTable) return;
        await this.deleteRows(msg.rows);
        break;
      case 'toggleColumn':
        if (!this.hasTable) return;
        await this.toggleColumn(msg.column, !!msg.hidden);
        break;
      case 'saveLayout':
        if (!this.hasTable) return;
        await this.saveLayout(msg.columnOrder, msg.columnWidths);
        break;
      case 'resetProfile':
        if (!this.hasTable) return;
        await this.resetProfile();
        break;
      case 'cancel':
        this.cancelRunningQuery();
        break;
      case 'exportData':
        await this.exportData(msg.format, msg.columns || [], msg.rows || []);
        break;
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (!this.hasTable && TableQueryView.queryViews.get(this.conn.id) === this) {
      TableQueryView.queryViews.delete(this.conn.id);
    }
  }

  private async sendInit(): Promise<void> {
    this.post({
      type: 'init',
      mode: 'query',
      initialSql: this.pendingQuery?.sql || this.buildSelect(),
      hasTable: this.hasTable,
      tableName: this.table || '',
      dbName: this.database || '',
      sortCol: this.sortCol,
      sortDir: this.sortDir,
      filterCol: this.filterCol,
      filterVal: this.filterVal,
      hiddenColumns: this.hiddenColumns,
      columnOrder: this.reconciledColumnOrder(),
      columnWidths: this.reconciledColumnWidths(),
    });
  }

  /** Queues queries so repeated runs cannot race in a reused result panel. */
  private queueQuery(
    sql: string,
    database?: string,
    onExecuted?: (result: any, error?: Error) => void,
  ): void {
    this.panel.title = `Query @ ${this.conn.name || this.conn.host}`;
    this.pendingQuery = { sql, database, onExecuted };
    this.panel.reveal(undefined, false);
    if (this.ready) {
      void this.executePendingQueries();
    }
  }

  private async executePendingQueries(): Promise<void> {
    if (this.executingPendingQuery) return;
    this.executingPendingQuery = true;
    try {
      while (this.pendingQuery) {
        const query = this.pendingQuery;
        this.pendingQuery = undefined;
        this.database = query.database;
        this.post({ type: 'querySql', sql: query.sql, dbName: query.database || '' });
        await this.execute(query.sql, query.onExecuted, query.database);
      }
    } finally {
      this.executingPendingQuery = false;
    }
  }

  /** Persist current sort/filter/hiddenColumns for this connection+database+table. */
  private async persistProfile(): Promise<void> {
    if (!this.hasTable || !this.table || !TableQueryView.profileStore) return;
    await TableQueryView.profileStore.save(this.conn.id, this.database, this.table, {
      sortCol: this.sortCol,
      sortDir: this.sortDir,
      filterCol: this.filterCol,
      filterVal: this.filterVal,
      hiddenColumns: this.hiddenColumns,
      columnOrder: this.columnOrder,
      columnWidths: this.columnWidths,
    });
  }

  private async toggleColumn(column: string, hidden: boolean): Promise<void> {
    const set = new Set(this.hiddenColumns);
    if (hidden) set.add(column);
    else set.delete(column);
    this.hiddenColumns = Array.from(set);
    await this.persistProfile();
    this.post({ type: 'hiddenColumns', hiddenColumns: this.reconciledHiddenColumns() });
  }

  private async saveLayout(columnOrder: unknown, columnWidths: unknown): Promise<void> {
    if (Array.isArray(columnOrder)) {
      this.columnOrder = columnOrder.filter((column): column is string => typeof column === 'string');
    }
    if (columnWidths && typeof columnWidths === 'object' && !Array.isArray(columnWidths)) {
      this.columnWidths = Object.fromEntries(
        Object.entries(columnWidths).filter(([column, width]) => (
          typeof column === 'string'
          && typeof width === 'number'
          && Number.isFinite(width)
          && width >= 80
          && width <= 1000
        )),
      );
    }
    await this.persistProfile();
    this.post({
      type: 'layout',
      columnOrder: this.reconciledColumnOrder(),
      columnWidths: this.reconciledColumnWidths(),
    });
  }

  private async resetProfile(): Promise<void> {
    if (!this.table || !TableQueryView.profileStore) return;
    this.sortCol = '';
    this.sortDir = '';
    this.filterCol = '';
    this.filterVal = '';
    this.hiddenColumns = [];
    this.columnOrder = [];
    this.columnWidths = {};
    this.offset = 0;
    await TableQueryView.profileStore.remove(this.conn.id, this.database, this.table);
    this.post({ type: 'profileReset' });
    await this.runInitial();
  }

  /** Intersects saved hiddenColumns with the last known field list so stale names never leak to the UI. */
  private reconciledHiddenColumns(): string[] {
    if (!this.lastFields.length) return this.hiddenColumns;
    const known = new Set(this.lastFields);
    return this.hiddenColumns.filter((c) => known.has(c));
  }

  private reconciledColumnOrder(): string[] {
    if (!this.lastFields.length) return this.columnOrder;
    const known = new Set(this.lastFields);
    const ordered = this.columnOrder.filter((column) => known.has(column));
    const remaining = this.lastFields.filter((column) => !ordered.includes(column));
    return [...ordered, ...remaining];
  }

  private reconciledColumnWidths(): Record<string, number> {
    if (!this.lastFields.length) return this.columnWidths;
    const known = new Set(this.lastFields);
    return Object.fromEntries(Object.entries(this.columnWidths).filter(([column]) => known.has(column)));
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

  private async execute(
    sql: string,
    onExecuted?: (result: any, error?: Error) => void,
    database = this.database,
  ): Promise<void> {
    try {
      if (!(await confirmSqlExecution(this.conn, sql))) return;
      this.post({ type: 'running' });
      const session = await this.manager.connect(this.conn);
      this.runningQuery = session.query;
      if (!this.hasTable && database && this.conn.dbType === 'MYSQL') {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`);
      }
      const stmts = splitSqlStatements(sql);
      let result: any;
      for (const stmt of stmts) result = await session.query.query(stmt);
      let pkCols: string[] = [];
      this.editablePkColumn = undefined;
      if (this.hasTable && this.table) {
        try {
          const cols = await session.metadata.getColumns(this.table, this.database);
          pkCols = cols.filter((c) => c.isPrimary).map((c) => c.name);
          if (pkCols.length === 1) this.editablePkColumn = pkCols[0];
        } catch {}
      }
      this.lastFields = (result?.fields || []).map((f: any) => f.name);
      this.post({
        type: 'result', result, pkColumns: pkCols, hiddenColumns: this.reconciledHiddenColumns(),
        columnOrder: this.reconciledColumnOrder(), columnWidths: this.reconciledColumnWidths(),
      });
      onExecuted?.(result);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
      onExecuted?.(undefined, err as Error);
    } finally {
      this.runningQuery = undefined;
      this.post({ type: 'finished' });
    }
  }

  private async updateCell(pkCol: string, rowId: any, col: string, val: string): Promise<void> {
    try {
      if (!this.editablePkColumn || pkCol !== this.editablePkColumn) {
        this.post({ type: 'error', message: 'Inline editing requires a single-column primary key.' });
        return;
      }
      if (!(await confirmSqlExecution(this.conn, `UPDATE ${this.table} SET ${col} = ? WHERE ${pkCol} = ?`))) return;
      const session = await this.manager.connect(this.conn);
      await session.data.updateCell(this.table!, pkCol, rowId, col, val === '' ? null : val, this.database);
      this.post({ type: 'cellUpdated' });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async deleteRows(rows: { pkColumn: string; pkValue: any }[]): Promise<void> {
    try {
      if (!rows.length || !this.editablePkColumn || rows.some((row) => row.pkColumn !== this.editablePkColumn)) {
        this.post({ type: 'error', message: 'Row deletion requires a single-column primary key.' });
        return;
      }
      if (!(await confirmSqlExecution(this.conn, `DELETE FROM ${this.table} WHERE ${rows[0]?.pkColumn || 'id'} = ?`))) return;
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

  private cancelRunningQuery(): void {
    if (!this.runningQuery?.cancel()) return;
    // Closing the driver session interrupts MySQL and PostgreSQL requests; the
    // next command transparently creates a fresh session.
    this.manager.disposeConn(this.conn.id);
  }

  private async exportData(format: TransferFormat, columns: string[], rows: Record<string, any>[]): Promise<void> {
    try {
      if (format === 'sql' && !this.table) {
        this.post({ type: 'error', message: 'SQL export requires a target table.' });
        return;
      }
      const { DialectRegistry } = await import('@db-client/core');
      const dialect = DialectRegistry.get(this.conn.dbType as any);
      const content = exportRows({ format, columns, rows, table: this.table, database: this.database, dialect });
      const baseName = this.table || 'result';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${baseName}_export.${format}`),
        filters: { [format.toUpperCase()]: [format] },
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      this.post({ type: 'exported', message: `Exported ${rows.length} row(s) to ${uri.fsPath}.` });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }
}
