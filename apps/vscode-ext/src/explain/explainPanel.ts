import * as vscode from 'vscode';
import { DatabaseType, validateIdent } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { ConnectionManager } from '../connection/connectionManager';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import { splitSqlStatements } from '../utils/sql';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { containsSecretSql } from '../utils/sqlSecret';
import type {
  ExplainDownMessage,
  ExplainStatementView,
  ExplainUpMessage,
} from '../result/protocol';
import { diagError } from '../utils/diagnostics';
import {
  buildExplainQuery,
  dialectFor,
  limitStatementPayload,
  parseExplainRows,
  rawForDisplay,
  rowsToText,
  shouldSkipExplain,
} from './explainRunner';

/**
 * P10：独立 EXPLAIN 计划面板。
 *
 * 同连接复用；webview 未完成两次 ready 前不发计划（避免重载/懒加载窗口丢消息）。
 * 所有 SQL 在 extension host 执行，webview 只收结构化计划或原始回退数据。
 */
export class ExplainPanel extends BaseWebView {
  private static readonly instances = new Map<string, ExplainPanel>();

  private sql: string;
  private database?: string;
  private schema?: string;
  private webviewReady = false;
  private pendingRun = true;
  private running = false;
  private generation = 0;

  private constructor(
    private readonly manager: ConnectionManager,
    private readonly conn: SavedConnection,
    sql: string,
    database?: string,
    schema?: string,
  ) {
    super(
      'devbelt.explain',
      l10n('wv.explain.panelTitle', { conn: conn.name || conn.host }),
      vscode.ViewColumn.Beside,
    );
    this.sql = sql;
    this.database = database;
    this.schema = schema;
    this.manager.retain(conn.id);
  }

  /** 打开/聚焦连接对应的计划面板；复用面板时替换 SQL 并重跑。 */
  static open(
    manager: ConnectionManager,
    conn: SavedConnection,
    sql: string,
    database?: string,
    schema?: string,
  ): void {
    const existing = ExplainPanel.instances.get(conn.id);
    if (existing) {
      existing.sql = sql;
      existing.database = database;
      existing.schema = schema;
      // 作废在途结果：它属于上一条 SQL。
      existing.generation += 1;
      existing.pendingRun = true;
      existing.reveal();
      if (existing.webviewReady && !existing.running) {
        existing.pendingRun = false;
        void existing.run();
      }
      return;
    }
    const view = new ExplainPanel(manager, conn, sql, database, schema);
    ExplainPanel.instances.set(conn.id, view);
  }

  /** 供测试/诊断：当前连接是否有计划面板。 */
  static find(connId: string): ExplainPanel | undefined {
    return ExplainPanel.instances.get(connId);
  }

  static closeAll(): void {
    for (const view of [...ExplainPanel.instances.values()]) view.dispose();
    ExplainPanel.instances.clear();
  }

  protected async handleMessage(msg: ExplainUpMessage): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.webviewReady = false;
        // 重载后也要重新拉一次当前 SQL 的计划。
        this.pendingRun = true;
        this.post({ type: 'init', mode: 'explain' } as ExplainDownMessage);
        return;
      }
      this.webviewReady = true;
      if (this.pendingRun) {
        this.pendingRun = false;
        await this.run();
      }
      return;
    }
    if (msg.type === 'rerun') {
      this.pendingRun = false;
      await this.run();
      return;
    }
    if (msg.type === 'copyText') {
      await vscode.env.clipboard.writeText(String(msg.text ?? ''));
    }
  }

  protected onDispose(): void {
    super.onDispose();
    this.webviewReady = false;
    if (ExplainPanel.instances.get(this.conn.id) === this) {
      ExplainPanel.instances.delete(this.conn.id);
    }
    this.manager.release(this.conn.id);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.pendingRun = true;
      return;
    }
    // generation 在 open() 换 SQL 时也会递增：在途结果属于旧 SQL，直接丢弃。
    const generation = ++this.generation;
    const isCurrent = (): boolean => generation === this.generation && this.webviewReady;
    this.running = true;
    try {
      if (containsSecretSql(this.sql)) {
        this.post({ type: 'error', message: l10n('wv.explain.secretBlocked') });
        return;
      }
      if (!(await confirmSqlExecution(
        this.conn,
        this.sql,
        this.manager.scanOptionsFor?.(this.conn),
        { database: this.database, schema: this.schema },
      ))) return;

      const dialect = dialectFor(this.conn.dbType);
      if (!dialect) {
        this.post({ type: 'error', message: l10n('wv.explain.unsupported', { dbType: this.conn.dbType }) });
        return;
      }

      this.post({ type: 'explainRunning' });
      const scanOptions = this.manager.scanOptionsFor?.(this.conn);
      const statements = splitSqlStatements(this.sql, scanOptions);
      const session = await this.manager.connectSql(this.conn, this.database);
      // MySQL 会话被同连接的其它面板共享，可能已 USE 到别的库：每次都显式切回目标库。
      const database = this.database || this.conn.database;
      if (database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`);
      }

      const payloads: ExplainStatementView[] = [];
      let skippedDdl = false;

      for (const raw of statements) {
        const statement = raw.trim();
        if (!statement) continue;
        if (shouldSkipExplain(statement, scanOptions)) {
          skippedDdl = true;
          continue;
        }

        const request = buildExplainQuery(this.conn.dbType, statement);
        let rows: unknown[];
        let fallbackReason: string | undefined;
        try {
          const result = await session.query.query(request.sql);
          rows = Array.isArray(result?.rows) ? result.rows : [];
        } catch (structuredError) {
          // 旧版本/受限权限：JSON 格式不可用时退回普通 EXPLAIN。
          // 普通 EXPLAIN 也失败说明是语句本身的问题（语法/表不存在），按错误抛出。
          const result = await session.query.query(request.fallbackSql);
          rows = Array.isArray(result?.rows) ? result.rows : [];
          fallbackReason = (structuredError as Error)?.message ?? String(structuredError);
        }

        const display = rawForDisplay(dialect, rows);
        if (fallbackReason !== undefined) {
          payloads.push(limitStatementPayload({
            sql: statement,
            plan: null,
            fallback: { reason: fallbackReason, rows: display, text: rowsToText(rows) },
          }));
          continue;
        }

        const parsed = parseExplainRows(dialect, rows);
        payloads.push(limitStatementPayload(parsed.ok
          ? { sql: statement, plan: { ...parsed.plan, raw: display } }
          : { sql: statement, plan: null, fallback: { reason: parsed.error, rows: display, text: rowsToText(rows) } }));
      }

      if (!isCurrent()) return;
      if (payloads.length === 0) {
        this.post({
          type: 'error',
          message: l10n(skippedDdl ? 'wv.query.explainUnsupported' : 'wv.explain.empty'),
        });
        return;
      }
      this.post({ type: 'explainPlan', statements: payloads });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      diagError('explain failed', message);
      if (isCurrent()) this.post({ type: 'error', message });
    } finally {
      this.running = false;
      if (this.pendingRun && this.webviewReady) {
        this.pendingRun = false;
        void this.run();
      }
    }
  }
}
