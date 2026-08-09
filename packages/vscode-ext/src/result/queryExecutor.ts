import { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { TableQueryView } from './tableQueryView';
import { HistoryStore } from '../history/historyStore';

export type QueryExecutionMode = 'reuse' | 'new';

/**
 * 查询执行器：创建查询视图并记录历史。
 *
 * 职责分离：
 *  - 本类：创建视图 + 记录历史（通过回调接收执行结果）
 *  - TableQueryView：在 Vue 应用 ready 后执行 SQL + 渲染结果
 */
export class QueryExecutor {
  private view?: TableQueryView;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly history?: HistoryStore,
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
    this.view = TableQueryView.openForQuery(conn, this.manager, sql, database, async (result, error) => {
      // 历史记录回调
      if (result) {
        await this.history?.add({
          sql,
          connection: conn.name || conn.host,
          connectionId: conn.id,
          database,
          costTime: Date.now() - start,
          rowCount: result.rows?.length ?? 0,
        });
      } else if (error) {
        await this.history?.add({
          sql,
          connection: conn.name || conn.host,
          connectionId: conn.id,
          database,
          costTime: Date.now() - start,
        });
      }
    }, mode);
  }

  /** 渲染外部结果（表结构元数据等）到当前视图 */
  renderExternal(result: import('@db-client/core').QueryResult): void {
    this.view?.renderExternal(result);
  }
}
