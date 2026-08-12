import * as vscode from 'vscode';
import { LoginForm } from '../sync/loginForm';
import { SyncConflictError } from '../sync/syncClient';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { promptMasterPassword } from './shared';

export function registerSyncCommands(deps: Deps, sub: Sub): void {
  const { auth, sync, syncBar, treeProvider } = deps;

  sub('dbclient.login', () => LoginForm.open(auth, () => syncBar.update()));

  sub('dbclient.logout', async () => {
    await auth.logout();
    syncBar.update();
    vscode.window.showInformationMessage(l10n('cmd.loggedOut'));
  });

  sub('dbclient.syncPull', async () => {
    const mp = await promptMasterPassword();
    if (!mp) return;
    await sync.pull(mp);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('cmd.pullDone'));
  });

  sub('dbclient.syncPush', async () => {
    const mp = await promptMasterPassword();
    if (!mp) return;
    try {
      await sync.push(mp);
      vscode.window.showInformationMessage(l10n('cmd.pushDone'));
    } catch (error) {
      if (error instanceof SyncConflictError) {
        const choice = await vscode.window.showWarningMessage(
          l10n('cmd.syncConflict', { version: error.latestVersion }),
          { modal: true },
          l10n('cmd.syncPullOverwrite'),
          l10n('cmd.syncPushOverwrite'),
        );
        if (choice === l10n('cmd.syncPullOverwrite')) {
          try {
            await sync.pull(mp);
            treeProvider.refresh();
            vscode.window.showInformationMessage(l10n('cmd.pullDone'));
          } catch (e) {
            vscode.window.showErrorMessage(l10n('cmd.pullFailed', { message: (e as Error).message }));
          }
        } else if (choice === l10n('cmd.syncPushOverwrite')) {
          try {
            await sync.forcePush(mp, error.latestVersion);
            vscode.window.showInformationMessage(l10n('cmd.pushDone'));
          } catch (e) {
            vscode.window.showErrorMessage(l10n('cmd.pushFailed', { message: (e as Error).message }));
          }
        }
        return;
      }
      vscode.window.showErrorMessage(l10n('cmd.pushFailed', { message: (error as Error).message }));
    }
  });

  sub('dbclient.explorerMenu', async () => {
    const loggedIn = auth.isLoggedIn();
    const items: (vscode.QuickPickItem & { value: string })[] = [
      { label: '$(add) New Group', description: 'Create a connection group', value: 'addGroup' },
      { label: '$(export) Export Connections', description: 'Export selected connections', value: 'exportConnections' },
      { label: '$(history) Query History', description: 'View recent queries', value: 'showHistory' },
      { label: '$(cloud-download) Pull from Cloud', description: 'Download & merge', value: 'syncPull' },
      { label: '$(cloud-upload) Push to Cloud', description: 'Upload local data', value: 'syncPush' },
      loggedIn
        ? { label: '$(sign-out) Logout', value: 'logout' }
        : { label: '$(sign-in) Login', value: 'login' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'DB Client actions' });
    if (picked) await vscode.commands.executeCommand(`dbclient.${picked.value}`);
  });
}
