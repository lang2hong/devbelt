import * as vscode from 'vscode';
import { LoginFormView } from '../sync/loginFormView';
import { SessionView } from '../sync/sessionView';
import { AccountView } from '../sync/accountView';
import { SyncConflictError } from '../sync/syncClient';
import { totalChanges } from '../sync/mergePlan';
import { SyncDiffView } from '../result/syncDiffView';
import { l10n } from '../i18n';
import { syncLoggedInContext } from '../extension';
import { refreshAdminCommand, isAdminUser, openAdminPanel } from './admin';
import type { Deps, Sub } from './shared';
import { withMasterPassword } from './shared';

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
  sub('dbclient.login', () => LoginFormView.open(auth, () => {
    syncBar.update();
    void syncLoggedInContext(auth);
    void refreshAdminCommand(auth);
  }));
  sub('dbclient.sessions', () => SessionView.open(auth));
  sub('dbclient.account', () => AccountView.open(auth));

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
    // previewPull 会解密远端数据 —— 这一步同时验证了主密码，
    // 所以「记住密码」交给 withMasterPassword 在成功之后做。
    const outcome = await withMasterPassword(
      sync,
      vscode.workspace.getConfiguration('dbclient.sync').get<boolean>('rememberMaster', true),
      (password) => sync.previewPull(password),
      (error) => vscode.window.showErrorMessage(l10n('cmd.pullFailed', { message: (error as Error).message })),
    );
    if (!outcome) return;
    const plan = outcome.result;
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
    /**
     * push 路径上验证主密码尤其关键：用错误密码加密上传会让其他设备再也解不开
     * 远端数据 —— 数据丢失级别的后果，而起因只是一次手抖。
     * previewPush 内部会解密远端数据，正好充当验证。
     */
    const outcome = await withMasterPassword(
      sync,
      vscode.workspace.getConfiguration('dbclient.sync').get<boolean>('rememberMaster', true),
      async (password) => {
        // 本地无变更时也要先验证密码：否则「无需推送」这条提示会在密码错误的
        // 情况下照样弹出，用户以为一切正常，直到某次真的有变更才发现推不上去。
        const plan = await sync.previewPush(password);
        return { plan, dirty: await sync.isLocalDirty() };
      },
      (error) => vscode.window.showErrorMessage(l10n('cmd.pushFailed', { message: (error as Error).message })),
    );
    if (!outcome) return;
    const { plan, dirty } = outcome.result;
    const mp = outcome.password;

    // 场景 A：本地无变更且无未推送的本地节，无需推送
    // P0-3：DB 重建后基线丢失（lastHash 不存在）→ isLocalDirty 恒 false，
    //       但 hasLocalUnpushed 可能为 true（本地有数据、远端为空）→ 仍需推送。
    if (!dirty && !plan.hasLocalUnpushed) {
      vscode.window.showInformationMessage(l10n('cmd.nothingToPush'));
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
      { label: '$(download) Import Connections', description: 'Import connections from a file', value: 'importConnections' },
      { label: '$(export) Export Connections', description: 'Export selected connections', value: 'exportConnections' },
      { label: '$(history) History', description: 'View recent queries', value: 'showHistory' },
      { label: '$(device-desktop) Device Sessions', description: 'Manage devices', value: 'sessions' },
      { label: '$(cloud-download) Pull from Cloud', description: 'Download & merge', value: 'syncPull' },
      { label: '$(cloud-upload) Push to Cloud', description: 'Upload local data', value: 'syncPush' },
    ];
    if (loggedIn && await isAdminUser(auth)) {
      items.push({ label: '$(shield) Admin Panel', description: 'Open the admin dashboard', value: 'openAdminPanel' });
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'DB Client actions' });
    if (!picked) return;
    if (picked.value === 'openAdminPanel') openAdminPanel(auth);
    else await vscode.commands.executeCommand(`dbclient.${picked.value}`);
  });

  // 账户入口收进底部状态栏：点击状态栏弹出 Account / Login / Logout，
  // 不再与「添加连接」等树操作挤在顶部「...」菜单里。
  sub('dbclient.accountMenu', async () => {
    const items: (vscode.QuickPickItem & { value: string })[] = auth.isLoggedIn()
      ? [
          { label: `$(device-desktop) ${l10n('sessions.title')}`, description: l10n('sessions.menuHint'), value: 'sessions' },
          { label: '$(account) Account', description: 'View plan, usage and subscription', value: 'account' },
          { label: '$(sign-out) Logout', value: 'logout' },
        ]
      : [{ label: '$(sign-in) Login', value: 'login' }];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'DB Client account' });
    if (!picked) return;
    await vscode.commands.executeCommand(`dbclient.${picked.value}`);
  });
}
