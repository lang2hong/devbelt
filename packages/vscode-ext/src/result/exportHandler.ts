import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/connectionManager';
import type { SavedConnection } from '../connection/connectionStore';
import {
  exportFileName,
  exportFilters,
  exportRows,
  toFileBytes,
  type TransferFormat,
} from '../data/transfer/exportService';

/**
 * 数据导出处理器：把当前页 / 全表导出为 CSV/JSON/SQL/Excel/XML。
 *
 * 与视图解耦：注入连接、管理器、表信息与消息回调。
 * 依赖 vscode UI（列选择、保存对话框），故以扩展进程内使用为主。
 *
 * 产物与表导出（commands/database.ts 的 runExportWizard）保持一致：
 * 共用文件名、过滤器与序列化实现，SQL 同样带 dump 头与事务包裹。
 */
export class ExportHandler {
  constructor(
    private readonly conn: SavedConnection,
    private readonly manager: ConnectionManager,
    private readonly table: string | undefined,
    private readonly database: string | undefined,
    private readonly post: (msg: any) => void,
  ) {}

  /** 是否给 CSV/TSV 前置 UTF-8 BOM：由 `dbclient.export.addUtf8Bom` 设置控制（默认关）。 */
  private withBom(format: TransferFormat): boolean {
    if (format !== 'csv' && format !== 'txt') return false;
    return vscode.workspace.getConfiguration('dbclient').get<boolean>('export.addUtf8Bom') === true;
  }

  async exportData(format: TransferFormat, columns: string[], rows: Record<string, any>[]): Promise<void> {
    try {
      if (format === 'sql' && !this.table) {
        this.post({ type: 'error', message: 'SQL export requires a target table.' });
        return;
      }
      const { DialectRegistry } = await import('@db-client/core');
      const dialect = DialectRegistry.get(this.conn.dbType as any);

      // 范围选择：当前页 / 全表
      const rangeOptions: { label: string; value: 'page' | 'all' }[] = [
        { label: vscode.l10n.t('Current page') + ` (${rows.length} rows)`, value: 'page' },
      ];
      if (this.table) rangeOptions.unshift({ label: vscode.l10n.t('Entire table'), value: 'all' as const });
      const range = rangeOptions.length > 1
        ? (await vscode.window.showQuickPick(rangeOptions, { placeHolder: vscode.l10n.t('Export range') }))?.value
        : 'page';
      if (!range) return;

      if (range === 'all' && this.table) {
        await this.exportEntireTable(format);
        return;
      }

      // 当前页：字段勾选
      const picked = await vscode.window.showQuickPick(
        columns.map((c) => ({ label: c, picked: true })),
        { canPickMany: true, placeHolder: vscode.l10n.t('Select columns to export') },
      );
      if (!picked?.length) return;
      const exportColumns = picked.map((p) => p.label);
      const projectedRows = rows.map((row) => {
        const out: Record<string, any> = {};
        for (const c of exportColumns) out[c] = row[c];
        return out;
      });
      const content = exportRows({
        format,
        columns: exportColumns,
        rows: projectedRows,
        table: this.table,
        database: this.database,
        dialect,
        sqlDump: format === 'sql' ? { serverInfo: this.serverInfo() } : undefined,
        withBom: this.withBom(format),
      });
      const uri = await this.askDestination(format);
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, toFileBytes(content));
      this.post({
        type: 'exported',
        message: vscode.l10n.t('Exported {count} row(s) to {path}', { count: projectedRows.length, path: uri.fsPath }),
      });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  /** 全表导出：分页读取，不受结果面板行数上限约束。 */
  private async exportEntireTable(format: TransferFormat): Promise<void> {
    const table = this.table!;
    const session = await this.manager.connect(this.conn);
    const [{ writeTableExport }, { writeChunksToFile }] = await Promise.all([
      import('../data/transfer/exportService'),
      import('../utils/writeChunks'),
    ]);
    const allColumns = (await session.metadata.getColumns(table, this.database)).map((c: any) => c.name);
    const picked = await vscode.window.showQuickPick(
      allColumns.map((c: string) => ({ label: c, picked: true })),
      { canPickMany: true, placeHolder: vscode.l10n.t('Select columns to export') },
    );
    if (!picked?.length) return;
    const uri = await this.askDestination(format);
    if (!uri) return;
    // 流式写盘：大表不再整表驻留内存。
    await writeChunksToFile(uri.fsPath, (write) => writeTableExport({
      source: { query: session.query, metadata: session.metadata, table: session.table },
      format,
      table,
      database: this.database,
      columns: picked.map((p) => p.label),
      includeStructure: format === 'sql',
      serverInfo: this.serverInfo(),
      withBom: this.withBom(format),
    }, write));
    this.post({ type: 'exported', message: vscode.l10n.t('Exported to {path}', { path: uri.fsPath }) });
  }

  private async askDestination(format: TransferFormat): Promise<vscode.Uri | undefined> {
    return vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(exportFileName(this.table || 'result', format)),
      filters: exportFilters(format),
    });
  }

  private serverInfo() {
    return {
      name: this.conn.name,
      dbType: this.conn.dbType,
      host: this.conn.host,
      port: this.conn.port,
    };
  }
}
