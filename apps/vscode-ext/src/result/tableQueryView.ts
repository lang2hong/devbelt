import * as vscode from 'vscode';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { reconcileColumnOrder, reconcileColumnWidths, reconcileHiddenColumns } from './tableLayout';
import { CompletionService } from './completionService';
import { RowEditor } from './rowEditor';
import { QueryRunner } from './queryRunner';
import { ExportHandler } from './exportHandler';

/** 结果面板承载的数据库对象类型。视图（VIEW）不可写。 */
export type ResultObjectType = 'table' | 'view';

export interface TableQueryViewOptions {
  /** 表 / 视图；视图不提供单元格编辑、插入行与复制 INSERT。 */
  objectType?: ResultObjectType;
  /** 表结构清单面板：无 SQL 可跑，不提供 EXPLAIN / 图表 / 导出。 */
  structure?: boolean;
}

/**
 * 表/查询视图：Vue 3 webview 模式。
 */
export class TableQueryView extends BaseWebView {
  private static readonly queryViews = new Map<string, TableQueryView>();
  private static readonly connRefs = new Map<string, number>();
  private readonly runner: QueryRunner;
  /** 结构面板要展示的现成结果（不经 SQL 执行）。 */
  private structurePayload?: { rows: any[]; fields: { name: string }[] };
  private hiddenColumns: string[] = [];
  private columnOrder: string[] = [];
  private columnWidths: Record<string, number> = {};
  private ready = false;
  private executingPendingQuery = false;
  private readonly completionService: CompletionService;
  private readonly rowEditor?: RowEditor;
  private readonly exporter?: ExportHandler;
  private pendingQueries: Array<{
    sql: string;
    database?: string;
    onExecuted?: (result: any, error?: Error) => void;
    explain?: boolean;
  }> = [];

  private constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly table: string | undefined,
    private database: string | undefined,
    viewColumn: vscode.ViewColumn,
    private readonly opts: TableQueryViewOptions = {},
    title?: string,
  ) {
    super(
      'devbelt.tableQuery',
      title ?? (table
        ? `${conn.name || conn.host} › ${database || ''} › ${table}`
        : `Query @ ${conn.name || conn.host}`),
      viewColumn,
    );
    // 引用计数：同一连接被多个视图共享，最后一个视图关闭时才释放连接。
    TableQueryView.connRefs.set(this.conn.id, (TableQueryView.connRefs.get(this.conn.id) ?? 0) + 1);
    this.runner = new QueryRunner(conn, manager, table, database, (msg) => this.post(msg));
    this.completionService = new CompletionService(manager, conn, database, (msg) => this.post(msg));
    if (table) {
      // 视图不建 RowEditor：编辑入口在前端已隐藏，这里再断一次链路，
      // 保证即使消息被伪造也不会对视图发出 UPDATE/INSERT/DELETE。
      if (opts.objectType !== 'view') {
        this.rowEditor = new RowEditor(manager, conn, table, database, (msg) => this.post(msg), {
          refresh: () => this.runner.execute(this.runner.buildSelect()),
        });
      }
      this.exporter = new ExportHandler(conn, manager, table, database, (msg) => this.post(msg));
    }
  }

  private get hasTable(): boolean {
    return this.runner.hasTable;
  }

  static init(extensionUri: vscode.Uri): void {
    BaseWebView.init(extensionUri);
  }

  static open(
    conn: SavedConnection,
    table: string,
    database: string,
    manager: ConnectionManager,
    opts: TableQueryViewOptions = {},
  ): void {
    new TableQueryView(conn, manager, table, database, vscode.ViewColumn.Active, {
      objectType: 'table',
      ...opts,
    });
  }

  /**
   * 表结构清单面板。
   *
   * 结构数据由调用方用元数据接口取好后直接投递，不再执行 `DESCRIBE`：
   * 那是 MySQL 专有语句，过去对 PG / SQLite 一律报语法错。
   */
  static openForStructure(
    conn: SavedConnection,
    manager: ConnectionManager,
    table: string,
    database: string | undefined,
    rows: any[],
  ): TableQueryView {
    const view = new TableQueryView(
      conn, manager, undefined, database, vscode.ViewColumn.Active,
      { structure: true },
      `Structure: ${conn.name || conn.host} › ${database || ''} › ${table}`,
    );
    view.structurePayload = {
      rows,
      fields: Object.keys(rows[0] || {}).map((name) => ({ name })),
    };
    return view;
  }

  static async openForQuery(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    database?: string,
    onExecuted?: (result: any, error?: Error) => void,
    mode: 'reuse' | 'new' = 'reuse',
  ): Promise<TableQueryView> {
    return TableQueryView.openWith(conn, manager, sql, database, onExecuted, mode, 'execute');
  }

  /**
   * 打开面板并直接以 EXPLAIN 模式执行，**不会先跑一遍原语句**。
   *
   * 原先 explain 是「openForQuery 排一条普通执行 + 再 queueQueryExplain 覆盖队列」。
   * 复用已有面板时 `queueQuery` 在 ready 状态下会同步启动执行，等 explain 覆盖
   * 队列时原语句已经开跑 —— 对写语句意味着一次真实副作用。
   */
  static async openForExplain(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    database?: string,
    mode: 'reuse' | 'new' = 'reuse',
  ): Promise<TableQueryView> {
    return TableQueryView.openWith(conn, manager, sql, database, undefined, mode, 'explain');
  }

  private static async openWith(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    database: string | undefined,
    onExecuted: ((result: any, error?: Error) => void) | undefined,
    mode: 'reuse' | 'new',
    kind: 'execute' | 'explain',
  ): Promise<TableQueryView> {
    const enqueue = (view: TableQueryView): void => {
      if (kind === 'explain') view.queueQueryExplain(sql, database);
      else view.queueQuery(sql, database, onExecuted);
    };

    const existing = mode === 'reuse' ? TableQueryView.queryViews.get(conn.id) : undefined;
    if (existing) {
      enqueue(existing);
      return existing;
    }
    // 结果面板放在 SQL 编辑器旁侧（右侧列）。不能用 splitEditorDown：那条命令会
    // 复制当前活动编辑器（SQL 文档），造成「同一份 SQL 文档出现两次」。
    const view = new TableQueryView(conn, manager, undefined, database, vscode.ViewColumn.Beside);
    TableQueryView.queryViews.set(conn.id, view);
    enqueue(view);
    return view;
  }

  protected async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        await this.sendInit();
        if (this.structurePayload) {
          this.post({
            type: 'result',
            result: { ...this.structurePayload, costTime: 0, truncated: false },
            pkColumns: [],
          });
        } else if (this.pendingQueries.length > 0) {
          await this.executePendingQueries();
        } else if (this.hasTable) {
          await this.runner.execute(this.runner.buildSelect());
        }
        break;
      case 'run':
        this.runner.offset = 0;
        await this.runner.execute(msg.sql || this.runner.buildSelect());
        break;
      case 'explain':
        await this.runner.explain(msg.sql);
        break;
      case 'nextPage':
        this.runner.offset += this.runner.limit; await this.runner.execute(this.runner.buildSelect());
        break;
      case 'prevPage':
        this.runner.offset = Math.max(0, this.runner.offset - this.runner.limit); await this.runner.execute(this.runner.buildSelect());
        break;
      case 'gotoPage': {
        if (!this.hasTable) return;
        const page = Math.floor(Number(msg.page));
        if (!Number.isFinite(page) || page < 1) return;
        this.runner.offset = (page - 1) * this.runner.limit;
        await this.runner.execute(this.runner.buildSelect());
        break;
      }
      case 'setLimit': {
        const n = Number(msg.limit);
        if (Number.isFinite(n) && n > 0) {
          this.runner.limit = Math.min(100000, Math.floor(n));
          this.runner.offset = 0;
          if (!msg.noRun) {
            await this.runner.execute(this.runner.buildSelect());
          }
        }
        break;
      }
      case 'sort':
        if (!this.hasTable) return;
        if (this.runner.sortCol === msg.column && this.runner.sortDir === 'ASC') this.runner.sortDir = 'DESC';
        else if (this.runner.sortCol === msg.column && this.runner.sortDir === 'DESC') { this.runner.sortCol = ''; this.runner.sortDir = ''; }
        else { this.runner.sortCol = msg.column; this.runner.sortDir = 'ASC'; }
        this.runner.offset = 0; await this.runner.execute(this.runner.buildSelect());
        break;
      case 'filter':
        if (!this.hasTable) return;
        this.runner.filterConditions = Array.isArray(msg.conditions) ? msg.conditions : [];
        this.runner.offset = 0; await this.runner.execute(this.runner.buildSelect());
        break;
      case 'updateCell':
        if (!this.hasTable) return;
        await this.rowEditor?.updateCell(msg.pkColumns, msg.pkValues, msg.column, msg.value);
        break;
      case 'deleteRows':
        if (!this.hasTable) return;
        await this.rowEditor?.deleteRows(msg.rows);
        break;
      case 'insertRow':
        if (!this.hasTable) return;
        await this.rowEditor?.insertRow(
          Array.isArray(msg.columns) ? msg.columns : [],
          Array.isArray(msg.values) ? msg.values : [],
        );
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
        this.runner.cancel();
        break;
      case 'exportData':
        await this.exporter?.exportData(msg.format, msg.columns || [], msg.rows || []);
        break;
      case 'completion':
        await this.completionService.handle(String(msg.before || ''), String(msg.text || ''));
        break;
    }
  }

  protected onDispose(): void {
    super.onDispose();
    this.ready = false;
    this.runner.dispose();
    if (TableQueryView.queryViews.get(this.conn.id) === this) {
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

  private async sendInit(): Promise<void> {
    this.post({
      type: 'init',
      mode: 'query',
      initialSql: this.pendingQueries[0]?.sql || this.runner.buildSelect(),
      hasTable: this.hasTable,
      tableName: this.table || '',
      dbName: this.database || '',
      sortCol: this.runner.sortCol,
      sortDir: this.runner.sortDir,
      filterConditions: this.runner.filterConditions,
      hiddenColumns: this.hiddenColumns,
      columnOrder: this.reconciledColumnOrder(),
      columnWidths: this.reconciledColumnWidths(),
      limit: this.runner.limit,
      viewKind: this.opts.structure ? 'structure' : 'query',
      objectType: this.opts.objectType ?? '',
      // 视图与结构面板均不可写；前端据此隐藏编辑/插入/复制 INSERT
      canEdit: !!this.rowEditor,
    });
  }

  /** Queues queries so repeated runs cannot race in a reused result panel. */
  private queueQuery(
    sql: string,
    database?: string,
    onExecuted?: (result: any, error?: Error) => void,
  ): void {
    this.panel.title = `Query @ ${this.conn.name || this.conn.host}`;
    this.pendingQueries.push({ sql, database, onExecuted });
    this.panel.reveal(undefined, false);
    if (this.ready) {
      void this.executePendingQueries();
    }
  }

  /** 覆盖待执行队列为 explain 模式。 */
  public queueQueryExplain(sql: string, database?: string): void {
    this.pendingQueries = [{ sql, database, explain: true }];
    if (this.ready) {
      void this.executePendingQueries();
    }
  }

  private async executePendingQueries(): Promise<void> {
    if (this.executingPendingQuery) return;
    this.executingPendingQuery = true;
    try {
      while (this.pendingQueries.length > 0) {
        const query = this.pendingQueries.shift()!;
        this.database = query.database;
        this.post({ type: 'querySql', sql: query.sql, dbName: query.database || '' });
        if (query.explain) {
          await this.runner.explain(query.sql);
        } else {
          await this.runner.execute(query.sql, query.onExecuted, query.database);
        }
      }
    } finally {
      this.executingPendingQuery = false;
    }
  }

  /** 切换列显隐（仅 session 内，不持久化）。 */
  private async toggleColumn(column: string, hidden: boolean): Promise<void> {
    const set = new Set(this.hiddenColumns);
    if (hidden) set.add(column);
    else set.delete(column);
    this.hiddenColumns = Array.from(set);
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
    this.post({
      type: 'layout',
      columnOrder: this.reconciledColumnOrder(),
      columnWidths: this.reconciledColumnWidths(),
    });
  }

  private async resetProfile(): Promise<void> {
    if (!this.table) return;
    this.runner.reset();
    this.hiddenColumns = [];
    this.columnOrder = [];
    this.columnWidths = {};
    this.post({ type: 'profileReset' });
    await this.runner.execute(this.runner.buildSelect());
  }

  /** Intersects saved hiddenColumns with the last known field list so stale names never leak to the UI. */
  private reconciledHiddenColumns(): string[] {
    return reconcileHiddenColumns(this.hiddenColumns, this.runner.lastFields);
  }

  private reconciledColumnOrder(): string[] {
    return reconcileColumnOrder(this.columnOrder, this.runner.lastFields);
  }

  private reconciledColumnWidths(): Record<string, number> {
    return reconcileColumnWidths(this.columnWidths, this.runner.lastFields);
  }

}
