import { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { ResultPanel, resultHtml } from './resultPanel';
import { HistoryStore } from '../history/historyStore';

/**
 * 查询执行器：绑定到某个连接会话，执行 SQL、渲染结果并记录历史。
 */
export class QueryExecutor {
  private panel?: ResultPanel;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly history?: HistoryStore,
  ) {}

  /**
   * 对指定连接执行 SQL。
   * @param conn 目标连接
   * @param sql SQL 语句
   */
  async run(conn: SavedConnection, sql: string): Promise<void> {
    const session = await this.manager.connect(conn);
    const panel = this.getPanel();
    const start = Date.now();
    try {
      const result = await session.query.query(sql);
      panel.render(result);
      await this.history?.add({
        sql,
        connection: conn.name || conn.host,
        costTime: Date.now() - start,
        rowCount: result.rows.length,
      });
    } catch (err) {
      panel.showError((err as Error).message);
      await this.history?.add({
        sql,
        connection: conn.name || conn.host,
        costTime: Date.now() - start,
      });
    }
  }

  /** 获取（首次创建并初始化）结果面板 */
  private getPanel(): ResultPanel {
    if (!this.panel) {
      const panel = ResultPanel.show();
      panel.bindHtml(resultHtml());
      this.panel = panel;
    } else {
      ResultPanel.show();
    }
    return this.panel;
  }
}