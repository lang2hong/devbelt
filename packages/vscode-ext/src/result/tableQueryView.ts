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
import { buildCountSql, buildTableSelect, type FilterCondition } from './tableQuerySql';
import { buildCandidates, detectContext, extractFromTable } from '../completion/sqlCompletionEngine';

/**
 * 表/查询视图：Vue 3 webview 模式。
 */
export class TableQueryView extends BaseWebView {
  private static readonly queryViews = new Map<string, TableQueryView>();
  private static readonly connRefs = new Map<string, number>();
  private static profileStore?: TableProfileStore;
  private offset = 0;
  private readonly limit = 100;
  private sortCol = '';
  private sortDir = '';
  private filterConditions: FilterCondition[] = [];
  private hiddenColumns: string[] = [];
  private columnOrder: string[] = [];
  private columnWidths: Record<string, number> = {};
  private lastFields: string[] = [];
  private editablePkColumn?: string;
  private readonly hasTable: boolean;
  private runningQuery?: QueryService;
  private ready = false;
  private executingPendingQuery = false;
  /** 补全元数据缓存（db → 表名；db:table → 列名），随视图销毁自动释放。 */
  private readonly completionTableCache = new Map<string, string[]>();
  private readonly completionColumnCache = new Map<string, string[]>();
  /** 查询串行队列：同一视图/会话的查询按序执行，避免并发污染 USE/事务状态并防止取消句柄被覆盖。 */
  private execQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.execQueue.then(fn, fn);
    this.execQueue = run.catch(() => {});
    return run;
  }
  private pendingQuery?: {
    sql: string;
    database?: string;
    onExecuted?: (result: any, error?: Error) => void;
    explain?: boolean;
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
    // 引用计数：同一连接被多个视图共享，最后一个视图关闭时才释放连接。
    TableQueryView.connRefs.set(this.conn.id, (TableQueryView.connRefs.get(this.conn.id) ?? 0) + 1);
    if (this.hasTable) {
      const saved = TableQueryView.profileStore?.get(conn.id, database, table!);
      if (saved) {
        this.sortCol = saved.sortCol || '';
        this.sortDir = saved.sortDir || '';
        this.filterConditions = Array.isArray(saved.filterConditions)
          ? (saved.filterConditions as FilterCondition[]).filter((c) => c && typeof c.column === 'string')
          : [];
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

  static async openForQuery(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    database?: string,
    onExecuted?: (result: any, error?: Error) => void,
    mode: 'reuse' | 'new' = 'reuse',
  ): Promise<TableQueryView> {
    const existing = mode === 'reuse' ? TableQueryView.queryViews.get(conn.id) : undefined;
    if (existing) {
      existing.queueQuery(sql, database, onExecuted);
      return existing;
    }
    // 结果面板放在 SQL 编辑器下方：先 split down，再在下方活动组创建 webview
    await vscode.commands.executeCommand('workbench.action.splitEditorDown');
    const view = new TableQueryView(conn, manager, undefined, database, vscode.ViewColumn.Active);
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
        this.offset = 0;
      if (this.hasTable) {
        await this.execute(msg.sql || this.buildSelect());
      } else {
        await this.execute(msg.sql);
      }
        break;
      case 'explain':
        await this.explain(msg.sql);
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
        this.filterConditions = Array.isArray(msg.conditions) ? msg.conditions : [];
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
      case 'completion': {
        try {
          const session = await this.manager.connect(this.conn);
          const before = String(msg.before || '');
          const text = String(msg.text || '');
          const db = this.database || this.conn.database;
          const tables = await this.getCompletionTables(session, db);
          const fromTable = extractFromTable(text);
          const ctx = detectContext(before);
          let columns: string[] = [];
          if (ctx === 'dot_column') {
            const m = before.match(/(\w+)\.\w*$/);
            if (m) columns = await this.getCompletionColumns(session, m[1], db);
          } else if (fromTable) {
            columns = await this.getCompletionColumns(session, fromTable, db);
          }
          const items = buildCandidates(ctx, { tables, columns, fromTable });
          this.post({ type: 'completionItems', items });
        } catch {
          this.post({ type: 'completionItems', items: [] });
        }
        break;
      }
    }
  }

  protected onDispose(): void {
    super.onDispose();
    this.disposed = true;
    if (!this.hasTable && TableQueryView.queryViews.get(this.conn.id) === this) {
      TableQueryView.queryViews.delete(this.conn.id);
    }
    // 引用计数归零：最后一个该连接的视图关闭时，释放底层连接（除非用户显式打开了该连接）。
    const refs = TableQueryView.connRefs.get(this.conn.id) ?? 0;
    if (refs <= 1) {
      TableQueryView.connRefs.delete(this.conn.id);
      if (!this.manager.isExplicit(this.conn.id)) {
        this.manager.disposeConn(this.conn.id);
      }
    } else {
      TableQueryView.connRefs.set(this.conn.id, refs - 1);
    }
  }

  private async getCompletionTables(session: any, db?: string): Promise<string[]> {
    const key = db || '';
    const cached = this.completionTableCache.get(key);
    if (cached) return cached;
    try {
      const tables = (await session.metadata.getTables(db)).map((t: any) => t.name);
      this.completionTableCache.set(key, tables);
      return tables;
    } catch {
      return [];
    }
  }

  private async getCompletionColumns(session: any, table: string, db?: string): Promise<string[]> {
    const key = `${db || ''}:${table}`;
    const cached = this.completionColumnCache.get(key);
    if (cached) return cached;
    try {
      const columns = (await session.metadata.getColumns(table, db)).map((c: any) => c.name);
      this.completionColumnCache.set(key, columns);
      return columns;
    } catch {
      return [];
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
      filterConditions: this.filterConditions,
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

  /** 覆盖待执行查询为 explain 模式。 */
  public queueQueryExplain(sql: string, database?: string): void {
    this.pendingQuery = { sql, database, explain: true };
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
        if (query.explain) {
          await this.explain(query.sql);
        } else {
          await this.execute(query.sql, query.onExecuted, query.database);
        }
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
      filterConditions: this.filterConditions,
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
    this.filterConditions = [];
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
    return buildTableSelect(
      this.conn.dbType, this.table, undefined, this.filterConditions,
      this.sortCol, this.sortDir, this.offset, this.limit,
    );
  }

  /** 构建 COUNT 查询（用于分页总条数）。 */
  private getCountSql(): string {
    if (!this.hasTable || !this.table) return '';
    return buildCountSql(this.conn.dbType, this.table, undefined, this.filterConditions);
  }

  private async runInitial(): Promise<void> {
    if (!this.hasTable) return;
    const sql = this.buildSelect();
    if (sql) await this.execute(sql);
  }

  private execute(
    sql: string,
    onExecuted?: (result: any, error?: Error) => void,
    database = this.database || this.conn.database,
  ): Promise<void> {
    return this.enqueue(() => this.doExecute(sql, onExecuted, database));
  }

  private async doExecute(
    sql: string,
    onExecuted?: (result: any, error?: Error) => void,
    database = this.database || this.conn.database,
  ): Promise<void> {
    if (this.disposed) return;
    try {
      if (!(await confirmSqlExecution(this.conn, sql))) return;
      this.post({ type: 'running' });
      const session = await this.manager.connect(this.conn);
      this.runningQuery = session.query;
      if (database && this.conn.dbType === 'MYSQL') {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`);
      }
      const stmts = splitSqlStatements(sql);
      const results: any[] = [];
      let transactionState: 'active' | 'committed' | 'rolledback' | undefined;
      for (const stmt of stmts) {
        const upper = stmt.toUpperCase().trim();
        if (upper === 'BEGIN' || upper.startsWith('START TRANSACTION')) {
          await session.query.query(stmt);
          transactionState = 'active';
          continue;
        }
        if (upper === 'COMMIT') { await session.query.query(stmt); transactionState = 'committed'; continue; }
        if (upper === 'ROLLBACK') { await session.query.query(stmt); transactionState = 'rolledback'; continue; }
        results.push(await session.query.query(stmt));
      }
      const result = results[results.length - 1];
      let pkCols: string[] = [];
      let cols: any[] = [];
      this.editablePkColumn = undefined;
      if (this.hasTable && this.table) {
        try {
          cols = await session.metadata.getColumns(this.table, this.database);
          pkCols = cols.filter((c) => c.isPrimary).map((c) => c.name);
          if (pkCols.length === 1) this.editablePkColumn = pkCols[0];
        } catch {}
      }
      // 表预览时并行查询过滤后总条数，用于分页信息
      let total: number | undefined;
      if (this.hasTable) {
        const countSql = this.getCountSql();
        if (countSql) {
          try {
            const countResult = await session.query.query(countSql);
            const countRow = countResult?.rows?.[0];
            total = countRow ? Number(countRow.total ?? countRow.count ?? countRow.COUNT) : undefined;
          } catch { /* COUNT 失败不阻塞结果展示 */ }
        }
      }
      this.lastFields = (result?.fields || []).map((f: any) => f.name);
      if (transactionState) this.post({ type: 'transaction', state: transactionState });
      if (this.hasTable) {
        // 表预览模式：给 fields 补列类型，供 filter 智能控件
        const colMap = new Map(cols.map((c: any) => [c.name, c]));
        const fieldsWithType = (result?.fields || []).map((f: any) => {
          const c = colMap.get(f.name);
          return { name: f.name, simpleType: c?.simpleType, type: c?.type };
        });
        this.post({
          type: 'result', result: { ...result, fields: fieldsWithType }, pkColumns: pkCols, total, sql: this.buildSelect(),
          hiddenColumns: this.reconciledHiddenColumns(),
          columnOrder: this.reconciledColumnOrder(), columnWidths: this.reconciledColumnWidths(),
        });
      } else {
        // 查询模式发送所有结果集
        this.post({
          type: 'results', results, sql, transactionState,
        });
      }
      onExecuted?.(result);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
      onExecuted?.(undefined, err as Error);
    } finally {
      this.runningQuery = undefined;
      this.post({ type: 'finished' });
    }
  }

  /** 执行 EXPLAIN 并展示查询计划。 */
  private async explain(sql: string): Promise<void> {
    try {
      if (!(await confirmSqlExecution(this.conn, sql))) return;
      this.post({ type: 'running' });
      const session = await this.manager.connect(this.conn);
      this.runningQuery = session.query;
      const prefix = this.conn.dbType === 'PG' ? 'EXPLAIN ANALYZE ' : 'EXPLAIN ';
      const stmts = splitSqlStatements(sql);
      const results: any[] = [];
      for (const stmt of stmts) {
        const explainSql = `${prefix}${stmt}`;
        results.push(await session.query.query(explainSql));
      }
      this.post({ type: 'results', results, sql: `${prefix}${sql}`, transactionState: undefined });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
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
      await session.data.deleteRows(
        this.table!,
        this.editablePkColumn,
        rows.map((r) => r.pkValue),
        this.database,
      );
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

      // 范围选择：当前页 / 全表 / 当前 SQL
      const rangeOptions: { label: string; value: 'page' | 'all' }[] = [
        { label: vscode.l10n.t('Current page') + ` (${rows.length} rows)`, value: 'page' },
      ];
      if (this.hasTable && this.table) rangeOptions.unshift({ label: vscode.l10n.t('Entire table'), value: 'all' as const });
      const range = rangeOptions.length > 1
        ? (await vscode.window.showQuickPick(rangeOptions, { placeHolder: vscode.l10n.t('Export range') }))?.value
        : 'page';
      if (!range) return;

      let exportColumns = columns;
      if (range === 'all' && this.table) {
        const session = await this.manager.connect(this.conn);
        const { exportTable } = await import('../data/transfer/exportService');
        const allColumns = (await session.metadata.getColumns(this.table, this.database)).map((c: any) => c.name);
        // 字段勾选
        const picked = await vscode.window.showQuickPick(
          allColumns.map((c: string) => ({ label: c, picked: true })),
          { canPickMany: true, placeHolder: vscode.l10n.t('Select columns to export') },
        );
        if (!picked?.length) return;
        exportColumns = picked.map((p) => p.label);
        const content = await exportTable({
          source: { query: session.query, metadata: session.metadata, table: session.table },
          format, table: this.table, database: this.database,
          columns: exportColumns,
        });
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${this.table}_export.${format}`),
          filters: { [format.toUpperCase()]: [format] },
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        this.post({ type: 'exported', message: vscode.l10n.t('Exported to {path}', { path: uri.fsPath }) });
        return;
      }

      // 当前页：字段勾选
      const picked = await vscode.window.showQuickPick(
        columns.map((c) => ({ label: c, picked: true })),
        { canPickMany: true, placeHolder: vscode.l10n.t('Select columns to export') },
      );
      if (!picked?.length) return;
      exportColumns = picked.map((p) => p.label);
      const projectedRows = rows.map((row) => {
        const out: Record<string, any> = {};
        for (const c of exportColumns) out[c] = row[c];
        return out;
      });
      const content = exportRows({ format, columns: exportColumns, rows: projectedRows, table: this.table, database: this.database, dialect });
      const baseName = this.table || 'result';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${baseName}_export.${format}`),
        filters: { [format.toUpperCase()]: [format] },
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      this.post({ type: 'exported', message: vscode.l10n.t('Exported {count} row(s) to {path}', { count: projectedRows.length, path: uri.fsPath }) });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }
}
