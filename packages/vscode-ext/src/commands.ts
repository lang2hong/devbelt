import * as vscode from 'vscode';
import { AuthService } from './sync/authService';
import type { Deps, SyncStatusBarLike } from './commands/shared';
import { makeSub } from './commands/shared';
import { registerConnectionCommands } from './commands/connection';
import { registerQueryCommands } from './commands/query';
import { registerTableCommands } from './commands/table';
import { registerDatabaseCommands } from './commands/database';
import { registerUserCommands } from './commands/user';
import { registerSavedQueryCommands, registerGroupCommands } from './commands/group';
import { registerSyncCommands } from './commands/sync';

export function registerCommands(deps: Deps): void {
  const sub = makeSub(deps.context);
  registerConnectionCommands(deps, sub);
  registerQueryCommands(deps, sub);
  registerTableCommands(deps, sub);
  registerDatabaseCommands(deps, sub);
  registerUserCommands(deps, sub);
  registerSavedQueryCommands(deps, sub);
  registerGroupCommands(deps, sub);
  registerSyncCommands(deps, sub);
  deps.context.subscriptions.push({ dispose: () => deps.manager.disposeAll() });
}

export class SyncStatusBar implements SyncStatusBarLike {
  private readonly item: vscode.StatusBarItem;
  constructor(private readonly auth: AuthService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'dbclient.login';
    this.update();
    this.item.show();
  }
  update(): void {
    if (this.auth.isLoggedIn()) {
      void this.auth.getEmail().then((email) => {
        this.item.text = '$(cloud) ' + (email || 'synced');
        this.item.command = 'dbclient.logout';
      });
    } else {
      this.item.text = '$(cloud) Not logged in';
      this.item.command = 'dbclient.login';
    }
  }
}
