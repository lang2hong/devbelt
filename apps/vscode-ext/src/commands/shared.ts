import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { ConnectionPathOverrideStore } from '../connection/connectionPathOverrideStore';
import { ConnectionContext } from '../connection/connectionContext';
import { DbTreeDataProvider } from '../tree/dbTreeDataProvider';
import type { DbTreeNode } from '../tree/dbTreeNode';
import { QueryExecutor } from '../result/queryExecutor';
import { HistoryStore } from '../history/historyStore';
import { AuthService } from '../sync/authService';
import type { SyncSessionFactory } from '@devbelt/db-host/sync/sessionFactory';
import { l10n } from '../i18n';
import { diagError } from '../utils/diagnostics';
import type { DatabaseOperation } from '@devbelt/db-core';
import type { ConnectionSession } from '../connection/connectionSession';
import type { AuthenticatorStore } from '../authenticator/store';

export interface Deps {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  manager: ConnectionManager;
  treeProvider: DbTreeDataProvider;
  overrideStore: ConnectionPathOverrideStore;
  executor: QueryExecutor;
  history: HistoryStore;
  auth: AuthService;
  connCtx: ConnectionContext;
  /** 同步会话工厂（账户面板读取同步状态用；未建会话时为 undefined）。 */
  syncFactory: SyncSessionFactory;
  /** P5：2FA/TOTP 验证器存储（S2 起注入）。 */
  authStore: AuthenticatorStore;
  /**
   * 当前树选中节点。
   * 树节点命令不携带 arguments：VS Code 会为「命令 + 参数」建缓存槽，
   * 整树刷新后旧槽被释放，落在刷新窗口里的点击会报
   * `Actual command not found, wanted to execute <cmd> /N`。
   */
  getSelectedNode?: () => DbTreeNode | undefined;
}

export type Sub = (cmd: string, handler: (...args: any[]) => any) => void;

/**
 * 命令注册统一入口。
 *
 * VS Code 不会处理命令处理器返回的 rejected promise：处理器里未捕获的异常只会变成
 * 一条无人管的拒绝（控制台可见、用户不可见），表现为「点了没反应」或是「部分完成但
 * 没有报错」。这里统一兜底：记录诊断并给出可读错误；取消类异常不报错。
 */
export function makeSub(context: vscode.ExtensionContext): Sub {
  return (cmd, handler) => context.subscriptions.push(vscode.commands.registerCommand(cmd, async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof Error && err.name === 'TransferCancelledError') return undefined;
      diagError(`command ${cmd} failed`, String(err));
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(l10n('cmd.failed', { command: cmd, message }));
      return undefined;
    }
  }));
}

export async function confirm(msgKey: string, btnKey: string, name: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(l10n(msgKey, { name }), { modal: true }, l10n(btnKey))) === l10n(btnKey);
}

/**
 * 为批量操作写一条汇总历史。
 *
 * 导入/恢复/库间传输/Mock 会执行成百上千条语句，逐条进历史会把上限 100 条的
 * 历史整段冲干（所以那些语句都带 `skipHistory`）。这里补一条人类可读的摘要，
 * 让「我什么时候往这张表导过数据」仍然查得到。
 *
 * 写入失败静默吞掉：历史是旁路设施，不能让它把一次已经成功的导入报成失败。
 */
export async function recordBulkHistory(
  deps: Deps,
  conn: SavedConnection,
  summary: string,
  database?: string,
  rowCount?: number,
  costTime = 0,
): Promise<void> {
  try {
    await deps.history.add({
      sql: summary,
      connection: conn.name || conn.host,
      connectionId: conn.id,
      database,
      costTime,
      rowCount,
    });
  } catch { /* best-effort history */ }
}

export function requireCapability(session: ConnectionSession, operation: DatabaseOperation): boolean {
  // 非 SQL 引擎没有 SQL 能力矩阵：一律视为不支持该操作。
  if (session.kind !== 'sql') {
    vscode.window.showWarningMessage(l10n('capability.unsupportedConnection', { operation }));
    return false;
  }
  if (session.capabilities.operations.includes(operation)) return true;
  vscode.window.showWarningMessage(l10n(session.capabilities ? 'capability.unsupportedDatabase' : 'capability.unsupportedConnection', { operation }));
  return false;
}

export async function openSqlDoc(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'sql' });
  await vscode.window.showTextDocument(doc);
}

export async function openSqlDocEditor(content: string): Promise<vscode.TextEditor | undefined> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'sql' });
  return vscode.window.showTextDocument(doc);
}

export async function openQueryFile(deps: Deps, conn: SavedConnection, database: string | undefined, queryId: string): Promise<void> {
  const q = deps.store.getQueries(conn.id, database).find((x) => x.id === queryId);
  if (!q) return;
  const dir = vscode.Uri.joinPath(deps.context.globalStorageUri, 'queries');
  await vscode.workspace.fs.createDirectory(dir);
  const file = vscode.Uri.joinPath(dir, `${queryId}.sql`);
  await vscode.workspace.fs.writeFile(file, Buffer.from(q.sql || '', 'utf8'));
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  deps.connCtx.setForDoc(editor.document.uri.toString(), conn, database);
  deps.connCtx.setSavedQueryForDoc(editor.document, queryId);
}

export async function pickConnection(store: ConnectionStore): Promise<SavedConnection | undefined> {
  // SQL 专用入口：排除 Redis（否则会建立一条 Redis 连接再抛内部错误）。
  const list = store.list().filter((c) => c.dbType !== DatabaseType.REDIS);
  if (!list.length) {
    vscode.window.showInformationMessage(l10n('cmd.noConnection'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name || c.host, detail: c.host, value: c })),
    { placeHolder: l10n('cmd.selectConnection') },
  );
  return picked?.value;
}