import * as vscode from 'vscode';
import { DatabaseType, validateIdent, validateSchemaIdent } from '@devbelt/db-core';
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
import { buildExplainPlanMessages } from '@devbelt/ai-core';
import { DEFAULT_FORMAT_MAX_CHARS, formatPlanText } from '@devbelt/explain-core';
import { AiBridge } from '../ai/aiBridge';
import { buildIndexSuggestions } from './indexSuggestions';
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
  /** 最近一次推给 webview 的结果（AI 解释的素材，与界面所见一致）。 */
  private lastStatements: ExplainStatementView[] = [];

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
      return;
    }
    if (msg.type === 'aiExplain') {
      this.requestAiExplain(msg.index);
    }
  }

  /**
   * P10 S4：把当前语句的计划发给 AI Chat 解释。
   *
   * 复用 `optimize` feature：沿用现有配额、审计与服务端代理白名单。
   * 发送的是规范化计划文本（有上限），不是引擎原始 JSON。
   */
  private requestAiExplain(index: number | undefined): void {
    const statement = this.lastStatements[index ?? 0];
    if (!statement) return;
    const bridge = AiBridge.tryGet();
    if (!bridge) {
      void vscode.window.showInformationMessage(l10n('ai.notEnabled'));
      return;
    }
    // 计划里的过滤条件来自 SQL 字面量；含密码的语句不外发。
    if (containsSecretSql(statement.sql)) {
      this.post({ type: 'error', message: l10n('wv.explain.secretBlocked') });
      return;
    }
    const planText = statement.plan ? formatPlanText(statement.plan) : undefined;
    const fallbackText = !planText && statement.fallback?.text
      ? statement.fallback.text.slice(0, DEFAULT_FORMAT_MAX_CHARS)
      : undefined;
    if (!planText && !fallbackText) return;
    bridge.requestChat({
      feature: 'optimize',
      messages: buildExplainPlanMessages({
        statements: [{
          sql: statement.sql,
          ...(planText ? { planText } : {}),
          ...(fallbackText ? { fallbackText } : {}),
        }],
        dbType: String(this.conn.dbType),
      }),
      title: l10n('ai.scenario.explainPlan'),
      connName: this.conn.name || this.conn.host,
      connId: this.conn.id,
      ...(this.database ? { database: this.database } : {}),
    });
  }

  protected onDispose(): void {
    super.onDispose();
    this.webviewReady = false;
    if (ExplainPanel.instances.get(this.conn.id) === this) {
      ExplainPanel.instances.delete(this.conn.id);
    }
    this.manager.release(this.conn.id);
  }

  /**
   * EXPLAIN one statement. Structured format first; on failure the legacy
   * EXPLAIN. If that also fails the statement itself is wrong and the error
   * propagates to the caller (shown on that statement's tab).
   */
  private async explainStatement(
    session: Awaited<ReturnType<ConnectionManager['connectSql']>>,
    dialect: NonNullable<ReturnType<typeof dialectFor>>,
    statement: string,
    database: string | undefined,
  ): Promise<ExplainStatementView> {
    const request = buildExplainQuery(this.conn.dbType, statement);
    let rows: unknown[];
    let fallbackReason: string | undefined;
    try {
      const result = await session.query.query(request.sql);
      rows = Array.isArray(result?.rows) ? result.rows : [];
    } catch (structuredError) {
      const result = await session.query.query(request.fallbackSql);
      rows = Array.isArray(result?.rows) ? result.rows : [];
      fallbackReason = (structuredError as Error)?.message ?? String(structuredError);
    }

    const display = rawForDisplay(dialect, rows);
    if (fallbackReason !== undefined) {
      return limitStatementPayload({
        sql: statement,
        plan: null,
        fallback: { reason: fallbackReason, rows: display, text: rowsToText(rows) },
      });
    }

    const parsed = parseExplainRows(dialect, rows);
    if (!parsed.ok) {
      return limitStatementPayload({
        sql: statement,
        plan: null,
        fallback: { reason: parsed.error, rows: display, text: rowsToText(rows) },
      });
    }
    let advice: Awaited<ReturnType<typeof buildIndexSuggestions>> = { suggestions: [], redundant: [] };
    try {
      advice = await buildIndexSuggestions(statement, parsed.plan, {
        session,
        dbType: this.conn.dbType,
        ...(database ? { database } : {}),
        ...(this.schema ? { schema: this.schema } : {}),
      });
    } catch (adviceError) {
      // 建议是附加信息：失败只记诊断，不影响计划展示。
      diagError('index suggestions failed', (adviceError as Error)?.message ?? String(adviceError));
    }
    return limitStatementPayload({
      sql: statement,
      plan: { ...parsed.plan, raw: display },
      suggestions: advice.suggestions,
      redundantIndexes: advice.redundant,
    });
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.pendingRun = true;
      return;
    }
    // generation 在 open() 换 SQL 时也会递增：在途结果属于旧 SQL，直接丢弃。
    const generation = ++this.generation;
    const isCurrent = (): boolean => generation === this.generation && this.webviewReady;
    let isolated: { close: () => void } | undefined;
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

      // 旧结果不再代表当前 SQL：AI 解释只能用本次结果。
      this.lastStatements = [];
      this.post({ type: 'explainRunning' });
      const scanOptions = this.manager.scanOptionsFor?.(this.conn);
      const statements = splitSqlStatements(this.sql, scanOptions);
      const database = this.database || this.conn.database;

      // PG 指定了 schema：在**独立会话**上设置 search_path，使计划与索引建议的元数据
      // 解析到同一 schema。不在共享会话上开事务 + SET LOCAL：用户可能在查询面板里
      // 开着未提交的事务，我们的 BEGIN 会被忽略、ROLLBACK 会回滚掉用户的数据。
      const pgSchema = this.conn.dbType === DatabaseType.PG && this.schema ? this.schema : undefined;
      let session: Awaited<ReturnType<ConnectionManager['connectSql']>>;
      if (pgSchema) {
        const opened = await this.manager.openIsolatedSql(this.conn, this.database);
        isolated = opened;
        session = opened.session;
        await session.query.query(
          `SET search_path TO ${session.query.wrap(validateSchemaIdent(pgSchema))}, public`,
          undefined,
          { skipHistory: true },
        );
      } else {
        session = await this.manager.connectSql(this.conn, this.database);
      }
      // MySQL 会话被同连接的其它面板共享，可能已 USE 到别的库：每次都显式切回目标库。
      if (database && this.conn.dbType === DatabaseType.MYSQL) {
        await session.query.query(`USE ${session.query.wrap(validateIdent(database))}`);
      }

      const payloads: ExplainStatementView[] = [];
      let skippedDdl = false;
      let failed = 0;

      for (const raw of statements) {
        const statement = raw.trim();
        if (!statement) continue;
        if (shouldSkipExplain(statement, scanOptions)) {
          skippedDdl = true;
          continue;
        }
        try {
          payloads.push(await this.explainStatement(session, dialect, statement, database));
        } catch (statementError) {
          // 单条失败（语法错/表不存在/SET 等无计划语句）只影响该条，其余语句照常展示。
          const message = (statementError as Error)?.message ?? String(statementError);
          diagError('explain failed', message);
          payloads.push({ sql: statement, plan: null, error: message });
          failed++;
        }
      }

      if (!isCurrent()) return;
      if (payloads.length === 0) {
        this.post({
          type: 'error',
          message: l10n(skippedDdl ? 'wv.query.explainUnsupported' : 'wv.explain.empty'),
        });
        return;
      }
      if (failed === payloads.length) {
        // 全部失败：直接给出（第一条的）真实报错，不渲染空标签页。
        this.post({ type: 'error', message: payloads[0].error ?? l10n('wv.explain.empty') });
        return;
      }
      this.lastStatements = payloads;
      this.post({ type: 'explainPlan', statements: payloads });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      diagError('explain failed', message);
      if (isCurrent()) this.post({ type: 'error', message });
    } finally {
      isolated?.close();
      this.running = false;
      if (this.pendingRun && this.webviewReady) {
        this.pendingRun = false;
        void this.run();
      }
    }
  }
}
