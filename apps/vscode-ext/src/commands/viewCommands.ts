import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection/connectionManager';
import type { DbTreeDataProvider } from '../tree/dbTreeDataProvider';
import type { BackupScheduler } from '../schedule/backupScheduler';
import type { AuthService } from '../sync/authService';
import type { AuditLogger } from '../utils/auditLogger';
import { TerminalService } from '../terminal/terminalService';
import { TableDesignView } from '../result/tableDesignView';
import { StatusView } from '../result/statusView';
import { ERDiagramView } from '../result/erDiagramView';
import { DataDiffView } from '../result/dataDiffView';
import { DashboardView } from '../result/dashboardView';
import { AuditLogView } from '../result/auditLogView';
import { PoolStatusView } from '../result/poolStatusView';
import { canUseErDiagram } from '@devkit/db-host/sync/entitlementGate';
import { configureBackupSchedule } from './backupWizard';
import { l10n } from '../i18n';

export interface ViewCommandDeps {
  context: vscode.ExtensionContext;
  manager: ConnectionManager;
  treeProvider: DbTreeDataProvider;
  auth: AuthService;
  backupScheduler: BackupScheduler;
  auditLogger: AuditLogger;
}

/**
 * 视图/面板类命令注册（从 extension.ts 抽出，降低 activate 篇幅）。
 */
export function registerViewCommands(deps: ViewCommandDeps): void {
  const { context, manager, treeProvider, auth, backupScheduler, auditLogger } = deps;

  context.subscriptions.push(
    // Terminal 集成
    vscode.commands.registerCommand('devbelt.openTerminal', (node: any) => {
      if (node?.conn) TerminalService.open(node.conn, node.database);
    }),
    // 表设计视图
    vscode.commands.registerCommand('devbelt.designTable', async (node: any) => {
      if (node?.conn && node?.database) {
        const session = await manager.connect(node.conn);
        if (!session.capabilities.operations.includes('getTableDefinition')) {
          vscode.window.showWarningMessage(l10n('design.unsupported'));
          return;
        }
        void TableDesignView.open(node.conn, node.label, node.database, manager, () => treeProvider.refreshNode(node));
      }
    }),
    // 新建表（webview 表单）：比丢一段 CREATE TABLE 模板到编辑器更直接，
    // 且建完可以接着在同一面板里加列/加索引。
    vscode.commands.registerCommand('devbelt.newTableDesigner', async (node: any) => {
      const database = node?.database ?? node?.conn?.database;
      if (!node?.conn || !database) return;
      void TableDesignView.openNew(node.conn, database, manager, () => treeProvider.refreshNode(node));
    }),
    // Server 状态面板
    vscode.commands.registerCommand('devbelt.serverStatus', (node: any) => {
      if (node?.conn) {
        StatusView.open(node.conn, manager);
      }
    }),
    // ER 图
    vscode.commands.registerCommand('devbelt.showERDiagram', (node: any) => {
      if (!canUseErDiagram(auth.getCachedEntitlement())) {
        vscode.window.showWarningMessage(l10n('entitlement.erRequired'));
        return;
      }
      if (node?.conn && node?.database) {
        ERDiagramView.open(node.conn, node.database, manager);
      }
    }),
    // 数据对比
    vscode.commands.registerCommand('devbelt.compareData', async (node: any) => {
      if (!node?.conn || !node?.database) return;
      const session = await manager.connect(node.conn);
      const targetDbs = (await session.metadata.getDatabases()).filter((d: string) => d !== node.database);
      if (!targetDbs.length) {
        vscode.window.showWarningMessage(l10n('compare.noOtherDatabases'));
        return;
      }
      const target = await vscode.window.showQuickPick(
        targetDbs.map((d: string) => ({ label: d, value: d })),
        { placeHolder: l10n('compare.chooseData', { database: node.database ?? '' }) },
      );
      if (!target) return;
      void DataDiffView.open(node.conn, node.database, node.conn, target.value, manager);
    }),
    // 性能仪表盘
    vscode.commands.registerCommand('devbelt.dashboard', (node: any) => {
      if (node?.conn) {
        DashboardView.open(node.conn, manager);
      }
    }),
    // 审计日志
    vscode.commands.registerCommand('devbelt.showAuditLog', () => {
      AuditLogView.open(auditLogger);
    }),
    // 连接池状态
    vscode.commands.registerCommand('devbelt.showPoolStatus', () => {
      PoolStatusView.open(manager);
    }),
    // 定时备份
    vscode.commands.registerCommand('devbelt.scheduleBackup', async (node: any) => {
      if (!node?.conn || !node?.database) return;
      await configureBackupSchedule(backupScheduler, node.conn.id, node.database);
    }),
  );
}