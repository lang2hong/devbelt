import * as vscode from 'vscode';
import type { Deps } from './commands/shared';
import { makeSub } from './commands/shared';
import { registerConnectionCommands } from './commands/connection';
import { registerConnectionPathFixCommands } from './commands/connectionPathFix';
import { registerQueryCommands } from './commands/query';
import { registerTableCommands } from './commands/table';
import { registerDatabaseCommands } from './commands/database';
import { registerUserCommands } from './commands/user';
import { registerAccountCommands } from './commands/account';
import { registerSavedQueryCommands, registerGroupCommands, registerQueryFolderCommands } from './commands/group';
import { registerDdlCommands } from './commands/ddl';
import { registerSearchCommands } from './commands/search';
import { l10n } from './i18n';

export function registerCommands(deps: Deps): void {
  const sub = makeSub(deps.context);
  registerConnectionCommands(deps, sub);
  registerConnectionPathFixCommands(deps, sub);
  registerQueryCommands(deps, sub);
  registerTableCommands(deps, sub);
  registerDatabaseCommands(deps, sub);
  registerUserCommands(deps, sub);
  registerAccountCommands(deps, sub);
  registerSavedQueryCommands(deps, sub);
  registerQueryFolderCommands(deps, sub);
  registerGroupCommands(deps, sub);
  registerDdlCommands(deps, sub);
  registerSearchCommands(deps, sub);
  sub('devbelt.explorerMenu', async () => {
    // 用分隔线分组（连接内容 / 同步 / 账户），避免扁平列表把树操作与账号操作混排。
    const section = (label: string): vscode.QuickPickItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: (vscode.QuickPickItem & { value?: string })[] = [
      section(l10n('explorer.section.connection')),
      { label: l10n('cmd.groups'), value: 'addGroup' },
      { label: l10n('cmd.showHistory'), value: 'showHistory' },
      { label: l10n('account.action.importConnections'), value: 'importConnections' },
      { label: l10n('account.action.exportConnections'), value: 'exportConnections' },
    ];
    if (deps.auth.isLoggedIn()) {
      const session = await deps.syncFactory.ensureSession().catch(() => undefined);
      const unlocked = session?.isUnlocked ?? false;
      items.push(
        section(l10n('explorer.section.sync')),
        { label: unlocked ? l10n('sync.statusLabel') : l10n('account.action.unlockOrInitialize'), value: 'sync' },
      );
      // 拉取/推送/自动同步开关仅已解锁时可用，避免锁定态点了被命令内部拒绝。
      if (unlocked) {
        const autoOn = vscode.workspace.getConfiguration().get<boolean>('devbelt.sync.autoSync', false);
        items.push(
          { label: l10n('account.action.pull'), value: 'syncPull' },
          { label: l10n('account.action.push'), value: 'syncPush' },
          { label: autoOn ? l10n('sync.autoDisable') : l10n('sync.autoEnable'), value: 'toggleAutoSync' },
        );
      }
      // 账户面板已含设备/套餐/管理后台/登出/改密，菜单不再重复列出。
      items.push(
        section(l10n('explorer.section.account')),
        { label: l10n('account.title'), value: 'account' },
      );
    } else {
      items.push(
        section(l10n('explorer.section.account')),
        { label: l10n('cmd.login'), value: 'login' },
      );
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('cmd.explorerMenu') });
    if (!picked?.value) return;
    const cmd: string | undefined = ({
      addGroup: 'devbelt.addGroup',
      showHistory: 'devbelt.showHistory',
      importConnections: 'devbelt.importConnections',
      exportConnections: 'devbelt.exportConnections',
      login: 'devbelt.login',
      account: 'devbelt.account',
      sync: 'devbelt.syncEntry',
      syncPull: 'devbelt.syncPull',
      syncPush: 'devbelt.syncPush',
      toggleAutoSync: 'devbelt.toggleAutoSync',
    } as Record<string, string>)[picked.value];
    if (cmd) await vscode.commands.executeCommand(cmd);
  });
  deps.context.subscriptions.push({ dispose: () => deps.manager.disposeAll() });
}