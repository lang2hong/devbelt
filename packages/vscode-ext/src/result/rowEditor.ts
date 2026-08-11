import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { confirmSqlExecution } from '../utils/sqlSafety';

export interface RowEditorOptions {
  /** 当前可编辑主键列（由视图在查询后根据元数据设置）。 */
  editablePkColumn: () => string | undefined;
  /** 数据变更后刷新结果（视图负责重新执行查询）。 */
  refresh: () => Promise<void>;
}

/**
 * 行编辑器：单元格更新 / 删除行 / 插入行。
 *
 * 与视图解耦：经回调读取可编辑主键状态、触发结果刷新。
 * SQL 生成与转义委托给 db-core 的 DataService。
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

  async updateCell(pkCol: string, rowId: any, col: string, val: string): Promise<void> {
    try {
      if (!this.opts.editablePkColumn() || pkCol !== this.opts.editablePkColumn()) {
        this.post({ type: 'error', message: 'Inline editing requires a single-column primary key.' });
        return;
      }
      if (!(await confirmSqlExecution(this.conn, `UPDATE ${this.table} SET ${col} = ? WHERE ${pkCol} = ?`))) return;
      const session = await this.manager.connect(this.conn);
      await session.data.updateCell(this.table, pkCol, rowId, col, val === '' ? null : val, this.database);
      this.post({ type: 'cellUpdated' });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  async deleteRows(rows: { pkColumn: string; pkValue: any }[]): Promise<void> {
    try {
      if (!rows.length || !this.opts.editablePkColumn() || rows.some((row) => row.pkColumn !== this.opts.editablePkColumn())) {
        this.post({ type: 'error', message: 'Row deletion requires a single-column primary key.' });
        return;
      }
      if (!(await confirmSqlExecution(this.conn, `DELETE FROM ${this.table} WHERE ${rows[0]?.pkColumn || 'id'} = ?`))) return;
      const session = await this.manager.connect(this.conn);
      await session.data.deleteRows(
        this.table,
        this.opts.editablePkColumn()!,
        rows.map((r) => r.pkValue),
        this.database,
      );
      this.post({ type: 'rowsDeleted', count: rows.length });
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
      await this.opts.refresh();
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }
}