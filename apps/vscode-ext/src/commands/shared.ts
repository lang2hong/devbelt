import * as vscode from 'vscode';
import { ConnectionStore } from '@devkit/db-host/connection/connectionStore';
import type { SavedConnection } from '@devkit/db-host/connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { ConnectionPathOverrideStore } from '../connection/connectionPathOverrideStore';
import { ConnectionContext } from '../connection/connectionContext';
import { DbTreeDataProvider } from '../tree/dbTreeDataProvider';
import { QueryExecutor } from '../result/queryExecutor';
import { HistoryStore } from '../history/historyStore';
import { AuthService } from '../sync/authService';
import type { SyncSessionFactory } from '@devkit/db-host/sync/sessionFactory';
import { l10n } from '../i18n';
import type { DatabaseOperation } from '@devkit/db-core';
import type { ConnectionSession } from '../connection/connectionManager';

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
}

export type Sub = (cmd: string, handler: (...args: any[]) => any) => void;

export function makeSub(context: vscode.ExtensionContext): Sub {
  return (cmd, handler) => context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
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
  const list = store.list();
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