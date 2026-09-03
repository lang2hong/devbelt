import * as vscode from 'vscode';
import type { Deps } from './commands/shared';
import { makeSub } from './commands/shared';
import { registerConnectionCommands } from './commands/connection';
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
    const picked = await vscode.window.showQuickPick(
      [
        { label: l10n('cmd.groups'), value: 'addGroup' },
        { label: l10n('cmd.showHistory'), value: 'showHistory' },
      ],
      { placeHolder: l10n('cmd.explorerMenu') },
    );
    if (!picked) return;
    if (picked.value === 'addGroup') await vscode.commands.executeCommand('dbclient.addGroup');
    else if (picked.value === 'showHistory') await vscode.commands.executeCommand('dbclient.showHistory');
  });
  deps.context.subscriptions.push({ dispose: () => deps.manager.disposeAll() });
}