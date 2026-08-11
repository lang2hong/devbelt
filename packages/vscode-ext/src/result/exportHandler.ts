import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import { exportRows, type TransferFormat } from '../data/transfer/exportService';

/**
 * 数据导出处理器：把当前页 / 全表导出为 CSV/JSON/SQL。
 *
 * 与视图解耦：注入连接、管理器、表信息与消息回调。
 * 依赖 vscode UI（列选择、保存对话框），故以扩展进程内使用为主。
 */
export class ExportHandler {
  constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly table: string | undefined,
    private readonly database: string | undefined,
    private readonly post: (msg: any) => void,
  ) {}

  async exportData(format: TransferFormat, columns: string[], rows: Record<string, any>[]): Promise<void> {
    try {
      if (format === 'sql' && !this.table) {
        this.post({ type: 'error', message: 'SQL export requires a target table.' });
        return;
      }
      const { DialectRegistry } = await import('@db-client/core');
      const dialect = DialectRegistry.get(this.conn.dbType as any);

      // 范围选择：当前页 / 全表 / 当前 SQL
      const rangeOptions: { label: string; value: 'page' | 'all' }[] = [
        { label: vscode.l10n.t('Current page') + ` (${rows.length} rows)`, value: 'page' },
      ];
      if (this.table) rangeOptions.unshift({ label: vscode.l10n.t('Entire table'), value: 'all' as const });
      const range = rangeOptions.length > 1
        ? (await vscode.window.showQuickPick(rangeOptions, { placeHolder: vscode.l10n.t('Export range') }))?.value
        : 'page';
      if (!range) return;

      let exportColumns = columns;
      if (range === 'all' && this.table) {
        const session = await this.manager.connect(this.conn);
        const { exportTable } = await import('../data/transfer/exportService');
        const allColumns = (await session.metadata.getColumns(this.table, this.database)).map((c: any) => c.name);
        const picked = await vscode.window.showQuickPick(
          allColumns.map((c: string) => ({ label: c, picked: true })),
          { canPickMany: true, placeHolder: vscode.l10n.t('Select columns to export') },
        );
        if (!picked?.length) return;
        exportColumns = picked.map((p) => p.label);
        const content = await exportTable({
          source: { query: session.query, metadata: session.metadata, table: session.table },
          format, table: this.table, database: this.database,
          columns: exportColumns,
        });
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${this.table}_export.${format}`),
          filters: { [format.toUpperCase()]: [format] },
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        this.post({ type: 'exported', message: vscode.l10n.t('Exported to {path}', { path: uri.fsPath }) });
        return;
      }

      // 当前页：字段勾选
      const picked = await vscode.window.showQuickPick(
        columns.map((c) => ({ label: c, picked: true })),
        { canPickMany: true, placeHolder: vscode.l10n.t('Select columns to export') },
      );
      if (!picked?.length) return;
      exportColumns = picked.map((p) => p.label);
      const projectedRows = rows.map((row) => {
        const out: Record<string, any> = {};
        for (const c of exportColumns) out[c] = row[c];
        return out;
      });
      const content = exportRows({ format, columns: exportColumns, rows: projectedRows, table: this.table, database: this.database, dialect });
      const baseName = this.table || 'result';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${baseName}_export.${format}`),
        filters: { [format.toUpperCase()]: [format] },
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      this.post({ type: 'exported', message: vscode.l10n.t('Exported {count} row(s) to {path}', { count: projectedRows.length, path: uri.fsPath }) });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }
}