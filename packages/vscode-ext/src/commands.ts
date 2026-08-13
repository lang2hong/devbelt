import * as vscode from 'vscode';
import { AuthService } from './sync/authService';
import { l10n } from './i18n';
import type { Deps, SyncStatusBarLike } from './commands/shared';
import { makeSub } from './commands/shared';
import { registerConnectionCommands } from './commands/connection';
import { registerQueryCommands } from './commands/query';
import { registerTableCommands } from './commands/table';
import { registerDatabaseCommands } from './commands/database';
import { registerUserCommands } from './commands/user';
import { registerSavedQueryCommands, registerGroupCommands, registerQueryFolderCommands } from './commands/group';
import { registerDdlCommands } from './commands/ddl';
import { registerSyncCommands } from './commands/sync';
import { registerSearchCommands } from './commands/search';

export function registerCommands(deps: Deps): void {
  const sub = makeSub(deps.context);
  registerConnectionCommands(deps, sub);
  registerQueryCommands(deps, sub);
  registerTableCommands(deps, sub);
  registerDatabaseCommands(deps, sub);
  registerUserCommands(deps, sub);
  registerSavedQueryCommands(deps, sub);
  registerQueryFolderCommands(deps, sub);
  registerGroupCommands(deps, sub);
  registerDdlCommands(deps, sub);
  registerSyncCommands(deps, sub);
  registerSearchCommands(deps, sub);
  deps.context.subscriptions.push({ dispose: () => deps.manager.disposeAll() });
}

export class SyncStatusBar implements SyncStatusBarLike {
  private readonly item: vscode.StatusBarItem;
  constructor(
    private readonly auth: AuthService,
    private readonly getLastSyncAt: () => number = () => 0,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'dbclient.login';
    this.update();
    this.item.show();
  }
  update(): void {
    if (!this.auth.isLoggedIn()) {
      this.item.text = '$(cloud) Not logged in';
      this.item.command = 'dbclient.login';
      return;
    }
    void Promise.all([this.auth.getEmail(), this.auth.client.getMe().catch(() => undefined)])
      .then(([email, me]) => {
        const rel = this.relativeTime(this.getLastSyncAt());
        if (me) {
          this.auth.setCachedPlan(me.plan);
          const dev = `${me.usage.devices}/${me.plan.maxDevices || '∞'}`;
          const bytes = `${formatBytes(me.usage.syncBytes)}/${me.plan.syncQuotaBytes ? formatBytes(me.plan.syncQuotaBytes) : '∞'}`;
          this.item.text = `$(cloud) ${email || 'synced'} · ${me.plan.name} · ${dev} dev · ${bytes}`;
          this.item.tooltip = `Plan: ${me.plan.name}\nDevices: ${dev}\nSync: ${bytes}\nConnections: ${me.usage.connections}/${me.plan.maxConnections || '∞'}\nLast sync: ${rel || 'never'}`;
        } else {
          this.item.text = `$(cloud) ${email || 'synced'}${rel ? ` · ${rel}` : ''}`;
        }
        this.item.command = 'dbclient.logout';
      });
  }
  private relativeTime(t: number): string {
    if (!t) return l10n('sync.never');
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60_000);
    if (min < 1) return l10n('sync.justNow');
    if (min < 60) return l10n('sync.minutesAgo', { n: min });
    const h = Math.floor(min / 60);
    if (h < 24) return l10n('sync.hoursAgo', { n: h });
    return l10n('sync.daysAgo', { n: Math.floor(h / 24) });
  }
}

function formatBytes(n: number): string {
  if (!n) return '0B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)}${u[i]}`;
}
