import * as vscode from 'vscode';
import { LoginForm } from '../sync/loginForm';
import { SessionView } from '../sync/sessionView';
import { PatView } from '../sync/patView';
import { SyncConflictError } from '../sync/syncClient';
import { totalChanges } from '../sync/mergePlan';
import { SyncDiffView } from '../result/syncDiffView';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { resolveMasterPassword } from './shared';

export function registerSyncCommands(deps: Deps, sub: Sub): void {
  const { auth, sync, syncBar, treeProvider } = deps;

  sub('dbclient.login', () => LoginForm.open(auth, () => syncBar.update()));
  sub('dbclient.sessions', () => SessionView.open(auth));
  sub('dbclient.pats', () => PatView.open(auth));

  sub('dbclient.logout', async () => {
    await sync.forgetMasterPassword();
    await auth.logout();
    syncBar.update();
    vscode.window.showInformationMessage(l10n('cmd.loggedOut'));
  });

  sub('dbclient.changeSyncPassword', async () => {
    const oldPw = await vscode.window.showInputBox({ prompt: l10n('cmd.oldPassword'), password: true });
    if (!oldPw) return;
    const newPw = await vscode.window.showInputBox({ prompt: l10n('cmd.newPassword'), password: true });
    if (!newPw) return;
    if (newPw.length < 12) {
      vscode.window.showErrorMessage(l10n('cmd.passwordTooShort'));
      return;
    }
    const confirmPw = await vscode.window.showInputBox({ prompt: l10n('cmd.confirmPassword'), password: true });
    if (confirmPw !== newPw) {
      vscode.window.showErrorMessage(l10n('cmd.passwordMismatch'));
      return;
    }
    try {
      await auth.changePassword(oldPw, newPw);
      vscode.window.showInformationMessage(l10n('cmd.passwordChanged'));
    } catch (error) {
      vscode.window.showErrorMessage((error as Error).message);
    }
  });

  sub('dbclient.syncPull', async () => {
    const mp = await resolveMasterPassword(sync, vscode.workspace.getConfiguration('dbclient.sync').get<boolean>('rememberMaster', false));
    if (!mp) return;
    let plan;
    try {
      plan = await sync.previewPull(mp);
    } catch (error) {
      vscode.window.showErrorMessage(l10n('cmd.pullFailed', { message: (error as Error).message }));
      return;
    }
    if (totalChanges(plan) === 0) {
      vscode.window.showInformationMessage(l10n('cmd.syncUpToDate'));
      return;
    }
    SyncDiffView.open(sync, plan, async () => {
      treeProvider.refresh();
      vscode.window.showInformationMessage(l10n('cmd.pullDone'));
    });
  });

  sub('dbclient.syncPush', async () => {
    const mp = await resolveMasterPassword(sync, vscode.workspace.getConfiguration('dbclient.sync').get<boolean>('rememberMaster', false));
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
            await sync.pull(mp, true);
            treeProvider.refresh();
            vscode.window.showInformationMessage(l10n('cmd.pullDone'));
          } catch (e) {
            vscode.window.showErrorMessage(l10n('cmd.pullFailed', { message: (e as Error).message }));
          }
        } else if (choice === l10n('cmd.syncPushOverwrite')) {
          try {
            await sync.forcePush(mp);
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
      { label: '$(devices) Sessions', description: 'Manage devices', value: 'sessions' },
      { label: '$(key) Access Tokens', description: 'Manage PATs', value: 'pats' },
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
