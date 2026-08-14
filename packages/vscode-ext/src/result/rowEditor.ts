import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { confirmSqlExecution } from '../utils/sqlSafety';
import { DataChangeEvent, eventBus } from '../utils/event';
import { AuditLogger } from '../utils/auditLogger';

export interface RowEditorOptions {
  /** 数据变更后刷新结果（视图负责重新执行查询）。 */
  refresh: () => Promise<void>;
}

/**
 * 行编辑器：单元格更新 / 删除行 / 插入行。
 *
 * 与视图解耦：经回调触发结果刷新。
 * SQL 生成与转义委托给 db-core 的 DataService。
 *
 * 无主键表使用所有列作为定位列（WHERE），可能影响多行（与 Navicat 行为一致）。
 */
export class RowEditor {
  constructor(
    private readonly manager: ConnectionManager,
    private readonly conn: SavedConnection,
    private readonly table: string,
    private readonly database: string | undefined,
    private readonly post: (msg: any) => void,
    private readonly opts: RowEditorOptions,
  ) {}

  async updateCell(pkColumns: string[], pkValues: any[], col: string, val: string): Promise<void> {
    try {
      if (!pkColumns.length) {
        this.post({ type: 'error', message: 'No identifying columns for this row.' });
        return;
      }
      if (!(await confirmSqlExecution(this.conn, `UPDATE ${this.table} SET ${col} = ? WHERE ${pkColumns.join(', ')} = ?`))) return;
      const session = await this.manager.connect(this.conn);
      await session.data.updateCell(this.table, pkColumns, pkValues, col, val, this.database);
      this.post({ type: 'cellUpdated' });
      this.notify('update', `UPDATE ${this.table} SET ${col} WHERE ${pkColumns.join(', ')}`, 1);
      await this.opts.refresh();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  async deleteRows(rows: { pkColumns: string[]; pkValues: any[] }[]): Promise<void> {
    try {
      if (!rows.length) return;
      const cols = rows[0].pkColumns;
      if (!cols.length) {
        this.post({ type: 'error', message: 'No identifying columns for row deletion.' });
        return;
      }
      if (!(await confirmSqlExecution(this.conn, `DELETE FROM ${this.table} WHERE ${cols.join(', ')} = ?`))) return;
      const session = await this.manager.connect(this.conn);
      await session.data.deleteRows(
        this.table,
        cols,
        rows.map((r) => r.pkValues),
        this.database,
      );
      this.post({ type: 'rowsDeleted', count: rows.length });
      this.notify('delete', `DELETE FROM ${this.table} WHERE ${cols.join(', ')}`, rows.length);
      await this.opts.refresh();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  async insertRow(columns: string[], values: (string | null)[]): Promise<void> {
    try {
      if (!(await confirmSqlExecution(this.conn, `INSERT INTO ${this.table} ...`))) return;
      const session = await this.manager.connect(this.conn);
      await session.data.insertRow(this.table, columns, values, this.database);
      this.notify('insert', `INSERT INTO ${this.table} (${columns.join(', ')})`, 1);
      await this.opts.refresh();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  /**
   * 发布数据变更事件 + 写审计。
   *
   * DataChangeEvent 此前只有类型定义、从无发布点；审计日志也只记录查询执行，
   * 数据编辑不留痕 —— 审计面板看不到谁改了哪一行。
   */
  private notify(
    operation: 'insert' | 'update' | 'delete',
    sql: string,
    rowCount: number,
  ): void {
    void eventBus.publish(new DataChangeEvent(this.conn.id, this.database ?? '', this.table, operation));
    AuditLogger.tryLog({
      action: operation === 'insert' ? 'data_insert' : operation === 'update' ? 'data_edit' : 'data_delete',
      connName: this.conn.name || this.conn.host,
      database: this.database,
      sql,
      rowCount,
    });
  }
}