import * as vscode from 'vscode';
import { DbTreeNode } from '../tree/dbTreeNode';
import type { SavedConnection } from '../connection/connectionStore';
import type { PathOverrideFields } from '../connection/connectionPathOverrideStore';
import { validateConnectionPaths } from '../connection/connectionPathValidator';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';

/**
 * B3 needsConfig 补齐命令。
 *
 * `dbclient.fixConnectionPaths`：对有效配置（覆盖优先）路径缺失/不可读的连接，逐字段引导
 * 补齐（文件类走文件选择器、字符串类走输入框）。用户取消某字段时保留已写入的前序覆盖并
 * 继续呈现剩余缺失项；空输入等同清除该字段覆盖。
 *
 * `dbclient.removeConnectionPathOverrides`：清除该连接全部本机覆盖，恢复同步源值。
 */

const FILE_FIELDS = ['dbPath', 'caPath', 'clientCertPath', 'clientKeyPath', 'sshPrivateKeyPath', 'sqliteCommand'] as const;
const TEXT_FIELDS = ['socketPath', 'connectionUrl'] as const;

function asConnection(arg: unknown): SavedConnection | undefined {
  if (!arg) return undefined;
  if (arg instanceof DbTreeNode) return arg.conn;
  return arg as SavedConnection;
}

async function promptForPath(field: string): Promise<string | undefined> {
  if ((FILE_FIELDS as readonly string[]).includes(field)) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: l10n('sync.fixPathOpen', { field }),
    });
    return uris?.[0]?.fsPath;
  }
  if ((TEXT_FIELDS as readonly string[]).includes(field)) {
    return vscode.window.showInputBox({
      prompt: l10n('sync.fixPathPrompt', { field }),
      ignoreFocusOut: true,
    });
  }
  return undefined;
}

export function registerConnectionPathFixCommands(deps: Deps, sub: Sub): void {
  const { treeProvider, overrideStore } = deps;

  sub('dbclient.fixConnectionPaths', async (arg?: unknown) => {
    const conn = asConnection(arg);
    if (!conn?.id) return;

    const result = await validateConnectionPaths(overrideStore.applyOverrides(conn));
    if (result.issues.length === 0) {
      vscode.window.showInformationMessage(l10n('sync.noPathFixNeeded'));
      await treeProvider.refreshPathIssues(conn.id);
      return;
    }

    for (const issue of result.issues) {
      const value = await promptForPath(issue.field);
      if (value === undefined) continue; // 取消该字段：保留已写入覆盖，继续呈现剩余
      await overrideStore.set(conn.id, { [issue.field]: value } as PathOverrideFields);
    }
    await treeProvider.refreshPathIssues(conn.id);
  });

  sub('dbclient.removeConnectionPathOverrides', async (arg?: unknown) => {
    const conn = asConnection(arg);
    if (!conn?.id) return;
    await overrideStore.clear(conn.id);
    await treeProvider.refreshPathIssues(conn.id);
  });
}