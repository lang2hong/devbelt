import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { TableQueryView } from './tableQueryView';
import { ExplainPanel } from '../explain/explainPanel';
import { QueryRunner } from './queryRunner';
import { HistoryStore } from '../history/historyStore';
import type { AuditLogger } from '../utils/auditLogger';
import { QueryExecutedEvent, DataChangeEvent, eventBus } from '@devbelt/db-host/utils/event';
import { classifyWriteKind } from '../utils/sqlRisk';
import { dialectScanOptions } from '../utils/sqlDialectOptions';
import { containsSecretSql } from '../utils/sqlSecret';

export type QueryExecutionMode = 'reuse' | 'new';

/** 审计里保留的 SQL 长度上限：避免超长语句撑爆 globalState */
const AUDIT_SQL_MAX = 2000;

/**
 * 查询执行器：创建查询视图并记录历史。
 *
 * 职责分离：
 *  - 本类：创建视图 + 记录历史（通过回调接收执行结果）
 *  - TableQueryView：在 Vue 应用 ready 后执行 SQL + 渲染结果
 */
export class QueryExecutor {
  constructor(
    private readonly manager: ConnectionManager,
    private readonly history?: HistoryStore,
    private readonly audit?: AuditLogger,
  ) {}

  /**
   * 对指定连接执行 SQL（通过 TableQueryView 查询模式）。
   * SQL 实际执行发生在 Vue 应用 mount 后的 ready 回调中。
   */
  async run(
    conn: SavedConnection,
    sql: string,
    database?: string,
    mode: QueryExecutionMode = 'reuse',
    viewColumn?: vscode.ViewColumn,
  ): Promise<void> {
    const start = Date.now();
    // 含明文口令的语句绝不落历史/审计（与 QueryHistoryRecorder 共用同一判定）。
    const secret = containsSecretSql(sql);
    await TableQueryView.openForQuery(conn, this.manager, sql, database, async (result, error) => {
      // 历史记录回调
      if (result) {
        const costTime = Date.now() - start;
        const rowCount = result.rows?.length ?? 0;
        if (!secret) {
          await this.history?.add({
            sql,
            connection: conn.name || conn.host,
            connectionId: conn.id,
            database,
            costTime,
            rowCount,
          });
          this.audit?.log({
            action: 'query_execute',
            connName: conn.name || conn.host,
            database,
            sql: sql.length > AUDIT_SQL_MAX ? `${sql.slice(0, AUDIT_SQL_MAX)}…` : sql,
            rowCount,
            costTime,
          });
        }
        // DDL 会改变库/表结构：发布数据变更事件让树刷新（DataChangeEvent 缺订阅者时
        // 树从不会在 SQL 编辑器跑完 DDL 后刷新，新表不可见）。
        if (classifyWriteKind(sql, this.manager.scanOptionsFor?.(conn) ?? dialectScanOptions(conn.dbType)) === 'ddl') {
          void eventBus.publish(new DataChangeEvent(conn.id, database ?? '', '', 'ddl'));
        }
        // QueryExecutedEvent 此前只有类型定义、从无发布点
        void eventBus.publish(new QueryExecutedEvent(conn.id, sql, costTime, rowCount));
      } else if (error) {
        const costTime = Date.now() - start;
        if (!secret) {
          await this.history?.add({
            sql,
            connection: conn.name || conn.host,
            connectionId: conn.id,
            database,
            costTime,
            failed: true,
          });
        }
        void eventBus.publish(new QueryExecutedEvent(conn.id, sql, costTime, 0, error.message));
      }
    }, mode, undefined, viewColumn);
  }

  /**
   * 无面板执行（AI Chat「在对话中运行」）：复用 QueryRunner 的确认/只读/生产门禁
   * 与拆分执行语义，但不创建结果面板；历史/审计/DDL 事件与 `run` 同口径。
   */
  async runHeadless(
    conn: SavedConnection,
    sql: string,
    database?: string,
    opts?: { onStart?: (handle: { cancel(): void }) => void },
  ): Promise<{ result?: any; error?: Error; canceled?: boolean; userCanceled?: boolean; costTime: number }> {
    const start = Date.now();
    const secret = containsSecretSql(sql);
    let called = false;
    let captured: { result?: any; error?: Error } = {};
    const runner = new QueryRunner(conn, this.manager, undefined, database, () => {});
    // 调用方（AI Chat）可经句柄取消在途查询：dispose 置 disposed（尚未开跑则直接跳过）
    // 并取消当前语句的 token（单查询取消，不牵连会话上其它查询）。
    let userCanceled = false;
    opts?.onStart?.({
      cancel: () => {
        userCanceled = true;
        runner.dispose();
      },
    });
    await runner.execute(sql, (result, error) => {
      called = true;
      captured = { ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) };
    });
    const costTime = Date.now() - start;
    // 用户主动取消：不记历史/审计（没有完成的执行），与「确认门禁被拒」的 canceled 区分。
    if (userCanceled) return { canceled: true, userCanceled: true, costTime };
    if (!called) {
      // 确认门禁未通过（用户取消）：无结果、无历史/审计。
      return { canceled: true, costTime };
    }
    if (captured.result) {
      const rowCount = captured.result.rows?.length ?? 0;
      if (!secret) {
        await this.history?.add({
          sql,
          connection: conn.name || conn.host,
          connectionId: conn.id,
          database,
          costTime,
          rowCount,
        });
        this.audit?.log({
          action: 'query_execute',
          connName: conn.name || conn.host,
          database,
          sql: sql.length > AUDIT_SQL_MAX ? `${sql.slice(0, AUDIT_SQL_MAX)}…` : sql,
          rowCount,
          costTime,
        });
      }
      if (classifyWriteKind(sql, this.manager.scanOptionsFor?.(conn) ?? dialectScanOptions(conn.dbType)) === 'ddl') {
        void eventBus.publish(new DataChangeEvent(conn.id, database ?? '', '', 'ddl'));
      }
      void eventBus.publish(new QueryExecutedEvent(conn.id, sql, costTime, rowCount));
    } else if (captured.error) {
      if (!secret) {
        await this.history?.add({
          sql,
          connection: conn.name || conn.host,
          connectionId: conn.id,
          database,
          costTime,
          failed: true,
        });
      }
      void eventBus.publish(new QueryExecutedEvent(conn.id, sql, costTime, 0, captured.error.message));
    }
    return { ...captured, costTime };
  }

  /**
   * 打开表结构清单面板。
   *
   * 与查询面板分开：结构面板没有可执行的 SQL，也不该提供 EXPLAIN / 图表 / 导出。
   * 结构数据由调用方经元数据接口取好后传入，不再对所有方言发 `DESCRIBE`。
   */
  openStructure(
    conn: SavedConnection,
    table: string,
    database: string | undefined,
    columns: Record<string, unknown>[],
    schema?: string,
  ): void {
    TableQueryView.openForStructure(conn, this.manager, table, database, columns, schema);
  }

  /**
   * 打开 EXPLAIN 计划面板。
   *
   * 计划解析与展示由 ExplainPanel 负责；这里只保留命令入口与审计。
   */
  async explain(conn: SavedConnection, sql: string, database?: string): Promise<void> {
    ExplainPanel.open(this.manager, conn, sql, database);
    this.audit?.log({
      action: 'query_explain',
      connName: conn.name || conn.host,
      database,
      sql: sql.length > AUDIT_SQL_MAX ? `${sql.slice(0, AUDIT_SQL_MAX)}…` : sql,
    });
  }
}
