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
import {
  buildExplainQuery,
  dialectFor,
  parseExplainRows,
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
  private runId = 0;

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
      existing.pendingRun = true;
      existing.reveal();
      if (existing.webviewReady) void existing.run();
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
    const runId = ++this.runId;
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
      if (this.database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(this.database))}`);
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
        let rows: unknown[] = [];
        let fallbackReason: string | undefined;

        try {
          const result = await session.query.query(request.sql);
          rows = Array.isArray(result?.rows) ? result.rows : [];
        } catch (structuredError) {
          // 旧版本/受限权限：JSON 格式不可用时退回普通 EXPLAIN，保留原始文本。
          try {
            const result = await session.query.query(request.fallbackSql);
            rows = Array.isArray(result?.rows) ? result.rows : [];
            fallbackReason = (structuredError as Error)?.message ?? String(structuredError);
          } catch (fallbackError) {
            payloads.push({
              sql: statement,
              plan: null,
              fallback: {
                reason: (fallbackError as Error)?.message ?? String(fallbackError),
                rows: [],
                text: '',
              },
            });
            continue;
          }
        }

        if (fallbackReason !== undefined) {
          payloads.push({
            sql: statement,
            plan: null,
            fallback: { reason: fallbackReason, rows, text: rowsToText(rows) },
          });
          continue;
        }

        const parsed = parseExplainRows(dialect, rows);
        if (parsed.ok) {
          payloads.push({ sql: statement, plan: parsed.plan });
        } else {
          payloads.push({
            sql: statement,
            plan: null,
            fallback: { reason: parsed.error, rows, text: rowsToText(rows) },
          });
        }
      }

      if (runId !== this.runId || !this.webviewReady) return;
      if (payloads.length === 0) {
        this.post({
          type: 'error',
          message: l10n(skippedDdl ? 'wv.query.explainUnsupported' : 'wv.explain.empty'),
        });
        return;
      }
      this.post({ type: 'explainPlan', statements: payloads });
    } catch (error) {
      if (runId === this.runId) {
        this.post({ type: 'error', message: (error as Error)?.message ?? String(error) });
      }
    } finally {
      this.running = false;
      if (this.pendingRun && this.webviewReady && runId === this.runId) {
        this.pendingRun = false;
        void this.run();
      }
    }
  }
}