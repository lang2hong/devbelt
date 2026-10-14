import * as vscode from 'vscode';
import { deriveSyncStatus } from '@devbelt/db-host/sync/syncStatus';
import type { SyncRunResult } from '@devbelt/db-host/sync/e2e/syncEngine';
import type { AuthService } from './authService';
import { l10n } from '../i18n';

/** 状态栏所需的会话最小结构（避免依赖具体类）。 */
export interface SyncStatusSession {
  isUnlocked: boolean;
  stalled: boolean;
  retrying: boolean;
  epochStale: boolean;
  lastError?: string;
  lastRun?: SyncRunResult;
  listConflicts(): unknown[];
}

/** 进行中进度（phase + 可选条数），用于状态栏"同步中…"。 */
export interface SyncProgressInfo {
  phase: 'pull' | 'push' | 'both';
  applied?: number;
  pushed?: number;
}

export interface SyncStatusBar {
  refresh(): void;
  /** 设置/清除"进行中"（null 清除）；设置后状态栏显示转圈 + 阶段/条数。 */
  setSyncing(info: SyncProgressInfo | null): void;
  dispose(): void;
}

/**
 * 同步状态栏控制器（从 extension.ts 抽出）。
 *
 * 依据同步会话状态渲染图标/文案/点击命令，并同步 `devbelt.sync.ready` /
 * `devbelt.sync.unlocked` 上下文键（驱动同步相关命令的 when）。
 */
export function createSyncStatusBar(
  context: vscode.ExtensionContext,
  auth: Pick<AuthService, 'isLoggedIn'>,
  getSession: () => SyncStatusSession | undefined,
  isAutoSyncEnabled: () => boolean = () => true,
): SyncStatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'devbelt.syncNow';
  item.hide();
  context.subscriptions.push(item);

  const setReady = (ready: boolean): void => {
    void vscode.commands.executeCommand('setContext', 'devbelt.sync.ready', ready);
  };
  const setUnlocked = (unlocked: boolean): void => {
    void vscode.commands.executeCommand('setContext', 'devbelt.sync.unlocked', unlocked);
  };

  let syncing: SyncProgressInfo | null = null;

  function refresh(): void {
    const session = getSession();
    // 进行中优先：转圈 + 阶段/条数，让用户感知到同步正在跑。
    if (syncing) {
      setReady(true);
      setUnlocked(session?.isUnlocked ?? false);
      item.show();
      item.command = 'devbelt.syncNow';
      item.text = `$(sync~spin) ${l10n('sync.statusSyncing')}`;
      const phaseLabel = syncing.phase === 'pull'
        ? l10n('sync.phasePull')
        : syncing.phase === 'push' ? l10n('sync.phasePush') : l10n('sync.phaseSync');
      const parts = [phaseLabel];
      if (typeof syncing.applied === 'number') parts.push(l10n('sync.progressApplied', { count: String(syncing.applied) }));
      if (typeof syncing.pushed === 'number') parts.push(l10n('sync.progressPushed', { count: String(syncing.pushed) }));
      item.tooltip = parts.join(' · ');
      return;
    }
    const status = deriveSyncStatus({
      isUnlocked: session?.isUnlocked ?? false,
      stalled: session?.stalled ?? false,
      retrying: session?.retrying ?? false,
      lastError: session?.lastError,
      lastRun: session?.lastRun,
      conflictCount: session?.listConflicts().length ?? 0,
    });
    if (status === 'hidden') {
      // 已登录但未解锁（未初始化或已锁定）：不再隐藏状态栏，显式给出可点击的同步入口，
      // 点击走 unlockPersonalSync（内部会区分「未初始化」/「已锁定」并引导）。
      if (auth.isLoggedIn()) {
        setReady(false);
        setUnlocked(false);
        item.command = 'devbelt.syncEntry';
        item.text = `$(lock) ${l10n('account.action.unlockOrInitialize')}`;
        item.tooltip = l10n('sync.statusLocked');
        item.show();
        return;
      }
      item.hide();
      setReady(false);
      setUnlocked(false);
      return;
    }
    setReady(true);
    setUnlocked(session?.isUnlocked ?? false);
    item.show();
    const reason = session!.lastError ?? session!.lastRun?.reason;
    // 自动同步开/关状态随 tooltip 呈现（关闭时点击仍是手动「立即同步」）。
    const autoNote = isAutoSyncEnabled() ? l10n('sync.autoOn') : l10n('sync.autoOff');
    item.command = 'devbelt.syncNow';
    switch (status) {
      case 'conflict':
        // S7k.8：冲突与发现统一进「数据体检」面板（状态栏仅作入口）。
        item.command = 'devbelt.syncDoctor';
        item.text = `$(warning) ${l10n('sync.statusConflict', { count: session!.listConflicts().length })}`;
        item.tooltip = `${l10n('sync.statusConflictTooltip')}\n${autoNote}`;
        break;
      case 'stalled':
        if (session!.epochStale) {
          item.command = 'devbelt.unlockPersonalSync';
          item.text = `$(warning) ${l10n('sync.statusLabel')}`;
          item.tooltip = `${l10n('sync.statusEpochStale')}\n${autoNote}`;
          break;
        }
        item.text = `$(warning) ${l10n('sync.statusLabel')}`;
        item.tooltip = `${l10n('sync.statusStalled')}\n${autoNote}`;
        break;
      case 'retrying':
        item.text = `$(sync~spin) ${l10n('sync.statusLabel')}`;
        item.tooltip = `${l10n('sync.statusError')}: ${reason ?? ''}\n${autoNote}`;
        break;
      case 'error':
        item.text = `$(error) ${l10n('sync.statusLabel')}`;
        item.tooltip = `${l10n('sync.statusError')}: ${reason ?? ''}\n${autoNote}`;
        break;
      default:
        item.text = `$(sync) ${l10n('sync.statusLabel')}`;
        item.tooltip = `${l10n('sync.statusIdle')}\n${autoNote}`;
        break;
    }
  }

  return {
    refresh,
    setSyncing: (info) => { syncing = info; refresh(); },
    dispose: () => item.dispose(),
  };
}