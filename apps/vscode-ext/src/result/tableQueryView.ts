import * as vscode from 'vscode';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from './baseWebView';
import { ExplainPanel } from '../explain/explainPanel';
import { reconcileColumnOrder, reconcileColumnWidths, reconcileHiddenColumns } from './tableLayout';
import { CompletionService } from './completionService';
import { RowEditor } from './rowEditor';
import { QueryRunner } from './queryRunner';
import { ExportHandler } from './exportHandler';
import { pgSchemaFor } from '../utils/sql';
import { buildDataQaMessages, buildDiagnoseMessages, formatRowSample } from '@devbelt/ai-core';
import { AiBridge } from '../ai/aiBridge';
import { readAiConfig } from '../ai/aiService';
import { sanitizeDiagnosePayload } from '../ai/diagnosePayload';
import { l10n } from '../i18n';

/** 结果面板承载的数据库对象类型。视图（VIEW）不可写。 */
export type ResultObjectType = 'table' | 'view';

export interface TableQueryViewOptions {
  /** 表 / 视图；视图不提供单元格编辑、插入行与复制 INSERT。 */
  objectType?: ResultObjectType;
  /** 表结构清单面板：无 SQL 可跑，不提供 EXPLAIN / 图表 / 导出。 */
  structure?: boolean;
  /** PG 命名空间（显式 schema；绝不从 database 推断）。 */
  schema?: string;
}

/**
 * 表/查询视图：Vue 3 webview 模式。
 */
export class TableQueryView extends BaseWebView {
  private static readonly queryViews = new Map<string, TableQueryView>();
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
  /** 本视图的 retain 释放函数（按会话键，见 connectionManager.retainFor）。 */
  private releaseRetain?: () => void;
  private pendingQueries: Array<{
    sql: string;
    database?: string;
    onExecuted?: (result: any, error?: Error) => void;
  }> = [];
  /**
   * P9 S4：最后一次单结果集快照（数据问答 / 0 行诊断素材）。
   * 行数截断到 50 做内存上界；样本发送前必过 `formatRowSample`（打码/截断）。
   */
  private lastResultSnapshot?: {
    sql: string;
    dbType?: string;
    fields: string[];
    rows: Array<Record<string, unknown>>;
    total?: number;
  };

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
    // 引用计数：同一连接被多个视图共享，最后一个视图关闭时才释放连接。用管理器的
// retain/release（而非各自维护的私有计数），这样其它视图/查询的持有同样被尊重。
    // 按会话键持有：PG 面板持有的是「该库」的会话，不豁免同连接其它衍生会话（B3）。
    this.releaseRetain = this.manager.retainFor(this.conn, this.database);
    const schema = opts.schema;
    this.runner = new QueryRunner(conn, manager, table, database, (msg) => this.postRunnerMessage(msg), schema);
    this.completionService = new CompletionService(manager, conn, database, (msg) => this.post(msg), schema);
    if (table) {
      // 视图不建 RowEditor：编辑入口在前端已隐藏，这里再断一次链路，
      // 保证即使消息被伪造也不会对视图发出 UPDATE/INSERT/DELETE。
      if (opts.objectType !== 'view') {
        this.rowEditor = new RowEditor(manager, conn, table, database, (msg) => this.post(msg), {
          refresh: () => this.runner.execute(this.runner.buildSelect()),
        }, schema);
      }
      this.exporter = new ExportHandler(conn, manager, table, database, (msg) => this.post(msg), schema);
    }
  }

  private get hasTable(): boolean {
    return this.runner.hasTable;
  }

  /** 账号切换：关闭所有结果面板（它们持有的会话属于上一个账号）。 */
  static closeAll(): void {
    for (const view of [...TableQueryView.queryViews.values()]) {
      try { view.dispose(); } catch { /* 已关闭 */ }
    }
    TableQueryView.queryViews.clear();
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
    schema?: string,
  ): TableQueryView {
    const view = new TableQueryView(
      conn, manager, undefined, database, vscode.ViewColumn.Active,
      { structure: true, schema },
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
    schema?: string,
    viewColumn?: vscode.ViewColumn,
  ): Promise<TableQueryView> {
    return TableQueryView.openWith(conn, manager, sql, database, onExecuted, mode, schema, viewColumn);
  }

  private static async openWith(
    conn: SavedConnection,
    manager: ConnectionManager,
    sql: string,
    database: string | undefined,
    onExecuted: ((result: any, error?: Error) => void) | undefined,
    mode: 'reuse' | 'new',
    schema?: string,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): Promise<TableQueryView> {
    const enqueue = (view: TableQueryView): void => {
      view.queueQuery(sql, database, onExecuted);
    };

    const existing = mode === 'reuse' ? TableQueryView.queryViews.get(conn.id) : undefined;
    if (existing) {
      enqueue(existing);
      return existing;
    }
    // 结果面板在当前编辑器组新开标签页（不再分屏）。不能用 splitEditorDown：那条命令会
    // 复制当前活动编辑器（SQL 文档），造成「同一份 SQL 文档出现两次」。
    const view = new TableQueryView(conn, manager, undefined, database, viewColumn, { schema });
    TableQueryView.queryViews.set(conn.id, view);
    enqueue(view);
    return view;
  }

  /** 观察 runner 输出：留住最后快照后原样转发（其它消息零改动）。 */
  private postRunnerMessage(msg: any): void {
    if (msg && msg.type === 'result' && typeof msg.sql === 'string' && Array.isArray(msg.result?.rows)) {
      this.lastResultSnapshot = {
        sql: msg.sql,
        ...(typeof msg.dbType === 'string' ? { dbType: msg.dbType } : {}),
        fields: Array.isArray(msg.result.fields)
          ? msg.result.fields.map((f: any) => String(f?.name ?? f)).filter(Boolean)
          : [],
        rows: (msg.result.rows as Array<Record<string, unknown>>).slice(0, 50),
        ...(typeof msg.total === 'number' ? { total: msg.total } : {}),
      };
    }
    this.post(msg);
  }

  /** AI 桥未初始化（AI 未启用）时给一次明确提示，而不是点了没反应。 */
  private requireAiBridge(): AiBridge | undefined {
    const bridge = AiBridge.tryGet();
    if (!bridge) void vscode.window.showInformationMessage(l10n('ai.notEnabled'));
    return bridge;
  }

  /** 数据问答（§6.11.3）：样本默认不发；勾选后按设置行数 + 打码 + 截断。 */
  private handleAiAskData(msg: any): void {
    const bridge = this.requireAiBridge();
    if (!bridge) return;
    const question = String(msg?.question ?? '').trim();
    if (!question) return;
    const snapshot = this.lastResultSnapshot;
    let sampleText: string | undefined;
    if (msg?.includeSample === true && snapshot) {
      const sample = formatRowSample(snapshot.fields, snapshot.rows, {
        maxRows: readAiConfig().dataSampleRows,
      });
      sampleText = sample.lines.join('\n');
    }
    bridge.requestChat({
      feature: 'data-qa',
      messages: buildDataQaMessages({
        question,
        ...(snapshot ? { sql: snapshot.sql } : {}),
        ...(snapshot && snapshot.fields.length > 0 ? { columns: snapshot.fields } : {}),
        ...(sampleText ? { sampleText } : {}),
        ...(snapshot && snapshot.total !== undefined ? { totalRows: snapshot.total } : {}),
        ...(snapshot?.dbType ? { dbType: snapshot.dbType } : {}),
      }),
      title: l10n('ai.scenario.dataQa'),
      connName: this.conn.name || this.conn.host,
      connId: this.conn.id,
      ...(this.database ? { database: this.database } : {}),
    });
  }

  /** 错误诊断（§6.11.2）：host 侧二次脱敏（sanitizeDiagnosePayload，纯函数可测）。 */
  private handleAiDiagnose(msg: any): void {
    const bridge = this.requireAiBridge();
    if (!bridge) return;
    const payload = sanitizeDiagnosePayload({ message: msg?.message, sql: msg?.sql, dbType: msg?.dbType });
    bridge.requestChat({
      feature: 'error-diagnose',
      messages: buildDiagnoseMessages({
        error: payload.error,
        ...(payload.sql ? { sql: payload.sql } : {}),
        ...(payload.dbType ? { dbType: payload.dbType } : {}),
      }),
      title: l10n('ai.scenario.diagnose'),
      connName: this.conn.name || this.conn.host,
      ...(this.database ? { database: this.database } : {}),
    });
  }

  /** 0 行诊断辅助（§6.7.1 C）：带入 SQL + 空结果到 Chat 排查。 */
  private handleAiWhyEmpty(): void {
    const bridge = this.requireAiBridge();
    if (!bridge) return;
    const snapshot = this.lastResultSnapshot;
    bridge.requestChat({
      feature: 'data-qa',
      messages: buildDataQaMessages({
        question: l10n('ai.whyEmpty.prompt'),
        ...(snapshot ? { sql: snapshot.sql } : {}),
        ...(snapshot && snapshot.fields.length > 0 ? { columns: snapshot.fields } : {}),
        totalRows: 0,
        ...(snapshot?.dbType ? { dbType: snapshot.dbType } : {}),
      }),
      title: l10n('ai.scenario.whyEmpty'),
      connName: this.conn.name || this.conn.host,
      connId: this.conn.id,
      ...(this.database ? { database: this.database } : {}),
    });
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
      case 'openExplain':
        ExplainPanel.open(this.manager, this.conn, msg.sql, this.database, this.opts.schema);
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
      case 'copyText':
        await vscode.env.clipboard.writeText(String(msg.text ?? ''));
        break;
      case 'completion':
        await this.completionService.handle(String(msg.before || ''), String(msg.text || ''));
        break;
      // P9 S4：AI 场景入口（错误诊断 / 数据问答 / 0 行诊断）。
      case 'aiDiagnose':
        this.handleAiDiagnose(msg);
        break;
      case 'aiAskData':
        this.handleAiAskData(msg);
        break;
      case 'aiWhyEmpty':
        this.handleAiWhyEmpty();
        break;
      case 'openAiChat': {
        // 只预填当前 SQL，不自动发送（点击图标不应该消耗额度）。
        const bridge = AiBridge.tryGet();
        if (!bridge) {
          void vscode.window.showInformationMessage(l10n('ai.notEnabled'));
          break;
        }
        bridge.prefillChat(String(msg.sql ?? ''));
        break;
      }
    }
  }

  protected onDispose(): void {
    super.onDispose();
    this.ready = false;
    this.runner.dispose();
    if (TableQueryView.queryViews.get(this.conn.id) === this) {
      TableQueryView.queryViews.delete(this.conn.id);
    }
    // 释放本视图的持有：计数归零且非显式打开时，管理器才真正关闭连接。
    this.releaseRetain?.();
    this.releaseRetain = undefined;
  }

  private async sendInit(): Promise<void> {
    this.post({
      type: 'init',
      mode: 'query',
      initialSql: this.pendingQueries[0]?.sql || this.runner.buildSelect(),
      hasTable: this.hasTable,
      tableName: this.table || '',
      dbName: this.database || '',
      // PG：限定「复制为 INSERT」用的 schema（dbName 是库名，不能当 schema 用）。
      schemaName: pgSchemaFor(this.conn, this.opts.schema) || '',
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

  /**
   * 视图切库时把 retain 从旧库会话键迁到新库会话键（先持有新键再释放旧键）。
   *
   * 面板复用同一视图执行「另一个库」的查询时，若仍持有旧库键，会：(a) 保护着一个
   * 已不再使用的会话不被 LRU 淘汰；(b) 新库会话无人持有，可能被淘汰导致重连。H3。
   */
  private migrateRetain(newDb?: string): void {
    if (newDb === this.database) return;
    const releaseOld = this.releaseRetain;
    this.releaseRetain = this.manager.retainFor(this.conn, newDb);
    releaseOld?.();
  }

  private async executePendingQueries(): Promise<void> {
    if (this.executingPendingQuery) return;
    this.executingPendingQuery = true;
    try {
      while (this.pendingQueries.length > 0) {
        const query = this.pendingQueries.shift()!;
        this.migrateRetain(query.database);
        this.database = query.database;
        this.runner.setDatabase(query.database);
        this.post({ type: 'querySql', sql: query.sql, dbName: query.database || '' });
        await this.runner.execute(query.sql, query.onExecuted, query.database);
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
