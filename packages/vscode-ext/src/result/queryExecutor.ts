import { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { TableQueryView } from './tableQueryView';
import { HistoryStore } from '../history/historyStore';
import type { AuditLogger } from '../utils/auditLogger';
import { QueryExecutedEvent, eventBus } from '../utils/event';

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
  ): Promise<void> {
    const start = Date.now();
    await TableQueryView.openForQuery(conn, this.manager, sql, database, async (result, error) => {
      // 历史记录回调
      if (result) {
        const costTime = Date.now() - start;
        const rowCount = result.rows?.length ?? 0;
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
        // QueryExecutedEvent 此前只有类型定义、从无发布点
        void eventBus.publish(new QueryExecutedEvent(conn.id, sql, costTime, rowCount));
      } else if (error) {
        const costTime = Date.now() - start;
        await this.history?.add({
          sql,
          connection: conn.name || conn.host,
          connectionId: conn.id,
          database,
          costTime,
        });
        void eventBus.publish(new QueryExecutedEvent(conn.id, sql, costTime, 0, error.message));
      }
    }, mode);
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
  ): void {
    TableQueryView.openForStructure(conn, this.manager, table, database, columns);
  }

  /**
   * 执行 EXPLAIN 查询计划。
   *
   * 走专门的 openForExplain：此前先 openForQuery（排一条普通执行）再覆盖队列为
   * explain，复用面板时原语句已经开跑，写语句会产生一次真实副作用。
   */
  async explain(conn: SavedConnection, sql: string, database?: string): Promise<void> {
    await TableQueryView.openForExplain(conn, this.manager, sql, database, 'reuse');
    this.audit?.log({
      action: 'query_explain',
      connName: conn.name || conn.host,
      database,
      sql: sql.length > AUDIT_SQL_MAX ? `${sql.slice(0, AUDIT_SQL_MAX)}…` : sql,
    });
  }
}
