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
  sub('dbclient.explorerMenu', async () => {
    const items: { label: string; value: string }[] = [
      { label: l10n('cmd.groups'), value: 'addGroup' },
      { label: l10n('cmd.showHistory'), value: 'showHistory' },
    ];
    if (deps.auth.isLoggedIn()) {
      items.push(
        { label: l10n('account.title'), value: 'account' },
        { label: l10n('sessions.title'), value: 'sessions' },
        { label: l10n('sync.statusLabel'), value: 'sync' },
        { label: l10n('account.action.pull'), value: 'syncPull' },
        { label: l10n('account.action.push'), value: 'syncPush' },
        { label: l10n('account.action.openConsole'), value: 'openConsole' },
        { label: l10n('cmd.logout'), value: 'logout' },
      );
    } else {
      items.push({ label: l10n('cmd.login'), value: 'login' });
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('cmd.explorerMenu') });
    if (!picked) return;
    const cmd: string | undefined = ({
      addGroup: 'dbclient.addGroup',
      showHistory: 'dbclient.showHistory',
      login: 'dbclient.login',
      account: 'dbclient.account',
      sessions: 'dbclient.sessions',
      sync: 'dbclient.syncEntry',
      syncPull: 'dbclient.syncPull',
      syncPush: 'dbclient.syncPush',
      openConsole: 'dbclient.openConsole',
      logout: 'dbclient.logout',
    } as Record<string, string>)[picked.value];
    if (cmd) await vscode.commands.executeCommand(cmd);
  });
  deps.context.subscriptions.push({ dispose: () => deps.manager.disposeAll() });
}