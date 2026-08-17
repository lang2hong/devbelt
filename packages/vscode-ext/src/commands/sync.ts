import * as vscode from 'vscode';
import { LoginForm } from '../sync/loginForm';
import { SessionView } from '../sync/sessionView';
import { SyncConflictError } from '../sync/syncClient';
import { totalChanges } from '../sync/mergePlan';
import { SyncDiffView } from '../result/syncDiffView';
import { l10n } from '../i18n';
import { syncLoggedInContext } from '../extension';
import { refreshAdminCommand, isAdminUser, openAdminPanel } from './admin';
import type { Deps, Sub } from './shared';
import { resolveMasterPassword } from './shared';

export function registerSyncCommands(deps: Deps, sub: Sub): void {
  const { auth, sync, syncBar, treeProvider } = deps;

  /**
   * 静默推送路径的乐观锁兜底：场景 B 判断远端无变化，但推送瞬间可能被别的设备抢先，
   * 保留原有的 pull overwrite / push overwrite 二选一作为并发最后防线。
   */
  const pushWithConflictFallback = async (mp: string): Promise<void> => {
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
  };

  // 登录成功后除刷新状态栏，还要同步 dbclient.loggedIn 上下文，
  // 否则命令面板里 logout / changeSyncPassword 仍然不可见
  sub('dbclient.login', () => LoginForm.open(auth, () => {
    syncBar.update();
    void syncLoggedInContext(auth);
    void refreshAdminCommand(auth);
  }));
  sub('dbclient.sessions', () => SessionView.open(auth));

  sub('dbclient.logout', async () => {
    await sync.forgetMasterPassword();
    await auth.logout();
    syncBar.update();
    await syncLoggedInContext(auth);
    await refreshAdminCommand(auth);
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
    const mp = await resolveMasterPassword(sync, vscode.workspace.getConfiguration('dbclient.sync').get<boolean>('rememberMaster', true));
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
    SyncDiffView.open(
      (strategy) => sync.applyPreviewedPull(strategy),
      plan,
      async () => {
        treeProvider.refresh();
        vscode.window.showInformationMessage(l10n('cmd.pullDone'));
      },
    );
  });

  sub('dbclient.syncPush', async () => {
    const mp = await resolveMasterPassword(sync, vscode.workspace.getConfiguration('dbclient.sync').get<boolean>('rememberMaster', true));
    if (!mp) return;
    // 场景 A：本地无变更，无需推送
    if (!(await sync.isLocalDirty())) {
      vscode.window.showInformationMessage(l10n('cmd.nothingToPush'));
      return;
    }
    // 场景 B/C：拉远端算 diff，判是否存在真冲突（远端有本地不知道的变化）
    let plan;
    try {
      plan = await sync.previewPush(mp);
    } catch (error) {
      vscode.window.showErrorMessage(l10n('cmd.pushFailed', { message: (error as Error).message }));
      return;
    }
    if (totalChanges(plan) === 0) {
      // 场景 B：远端无变化，静默推送；并发冲突仍走乐观锁兜底
      await pushWithConflictFallback(mp);
      return;
    }
    // 场景 C：双向都有变化，让用户在 diff 预览里选策略
    SyncDiffView.open(
      async (strategy) => {
        if (strategy === 'local') {
          await sync.forcePush(mp);
        } else if (strategy === 'remote') {
          await sync.applyPreviewedPull('remote');
        } else {
          await sync.applyPreviewedPull('merge');
          await sync.push(mp);
        }
      },
      plan,
      async () => {
        treeProvider.refresh();
        vscode.window.showInformationMessage(l10n('cmd.pushDone'));
      },
    );
  });

  sub('dbclient.explorerMenu', async () => {
    const loggedIn = auth.isLoggedIn();
    const items: (vscode.QuickPickItem & { value: string })[] = [
      { label: '$(add) New Group', description: 'Create a connection group', value: 'addGroup' },
      { label: '$(export) Export Connections', description: 'Export selected connections', value: 'exportConnections' },
      { label: '$(history) History', description: 'View recent queries', value: 'showHistory' },
      { label: '$(device-desktop) Device Sessions', description: 'Manage devices', value: 'sessions' },
      { label: '$(cloud-download) Pull from Cloud', description: 'Download & merge', value: 'syncPull' },
      { label: '$(cloud-upload) Push to Cloud', description: 'Upload local data', value: 'syncPush' },
      loggedIn
        ? { label: '$(sign-out) Logout', value: 'logout' }
        : { label: '$(sign-in) Login', value: 'login' },
    ];
    if (loggedIn && await isAdminUser(auth)) {
      items.splice(items.length - 1, 0, { label: '$(shield) Admin Panel', description: 'Open the admin dashboard', value: 'openAdminPanel' });
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'DB Client actions' });
    if (!picked) return;
    if (picked.value === 'openAdminPanel') openAdminPanel(auth);
    else await vscode.commands.executeCommand(`dbclient.${picked.value}`);
  });
}
