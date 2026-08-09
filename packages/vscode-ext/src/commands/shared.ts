import * as vscode from 'vscode';
import { ConnectionStore } from '../connection/connectionStore';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { ConnectionContext } from '../connection/connectionContext';
import { DbTreeDataProvider } from '../tree/dbTreeDataProvider';
import { QueryExecutor } from '../result/queryExecutor';
import { HistoryStore } from '../history/historyStore';
import { AuthService } from '../sync/authService';
import { SyncManager } from '../sync/syncManager';
import { l10n } from '../i18n';
import type { DatabaseOperation } from '@db-client/core';
import type { ConnectionSession } from '../connection/connectionManager';

export interface Deps {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  manager: ConnectionManager;
  treeProvider: DbTreeDataProvider;
  executor: QueryExecutor;
  history: HistoryStore;
  auth: AuthService;
  sync: SyncManager;
  syncBar: SyncStatusBarLike;
  connCtx: ConnectionContext;
}

export interface SyncStatusBarLike {
  update(): void;
}

export type Sub = (cmd: string, handler: (...args: any[]) => any) => void;

export function makeSub(context: vscode.ExtensionContext): Sub {
  return (cmd, handler) => context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
}

export async function confirm(msgKey: string, btnKey: string, name: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(l10n(msgKey, { name }), { modal: true }, l10n(btnKey))) === l10n(btnKey);
}

export function requireCapability(session: ConnectionSession, operation: DatabaseOperation): boolean {
  if (session.capabilities.operations.includes(operation)) return true;
  vscode.window.showWarningMessage(`${session.capabilities ? 'This database' : 'Connection'} does not support ${operation}.`);
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

export async function promptMasterPassword(): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt: l10n('cmd.masterPassword'), password: true });
}
