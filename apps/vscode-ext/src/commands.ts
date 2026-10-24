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
import { registerAuthenticatorCommands } from './commands/authenticator';
import { registerDictionaryCommands } from './commands/dictionary';
import { registerMaskingCommands } from './commands/masking';
import { buildExplorerMenu, EXPLORER_MENU_COMMANDS } from './commands/explorerMenu';
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
  registerAuthenticatorCommands(deps, sub);
  registerDictionaryCommands(deps, sub);
  registerMaskingCommands(deps, sub);
  sub('devbelt.explorerMenu', async () => {
    const loggedIn = deps.auth.isLoggedIn();
    const session = loggedIn ? await deps.syncFactory.ensureSession().catch(() => undefined) : undefined;
    const unlocked = session?.isUnlocked ?? false;
    const autoOn = unlocked && vscode.workspace.getConfiguration().get<boolean>('devbelt.sync.autoSync', false);
    const items: (vscode.QuickPickItem & { value?: string })[] = buildExplorerMenu({ loggedIn, unlocked, autoOn })
      .map((it) => (it.separator
        ? { label: it.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: it.label, value: it.value }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('cmd.explorerMenu') });
    if (!picked?.value) return;
    const cmd = EXPLORER_MENU_COMMANDS[picked.value];
    if (cmd) await vscode.commands.executeCommand(cmd);
  });
  deps.context.subscriptions.push({ dispose: () => deps.manager.disposeAll() });
}