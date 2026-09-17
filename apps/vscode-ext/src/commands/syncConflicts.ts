import * as vscode from 'vscode';
import { l10n } from '../i18n';
import type { SyncSessionFactory } from '../sync/sessionFactory';

/**
 * B4 冲突面板（QuickPick）：列出未解决冲突，逐条或批量执行 Use Local / Use Remote / Cancel。
 */

interface ConflictPick extends vscode.QuickPickItem {
  recordId?: string;
  bulk?: 'local' | 'merge' | 'remote';
}

export function registerConflictCommands(context: vscode.ExtensionContext, factory: SyncSessionFactory): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('devbelt.resolveConflicts', () => resolveConflicts(factory)),
  );
}

async function resolveConflicts(factory: SyncSessionFactory): Promise<void> {
  const session = factory.current;
  if (!session?.isUnlocked) return;
  const conflicts = session.listConflicts();
  if (conflicts.length === 0) {
    vscode.window.showInformationMessage(l10n('sync.noConflicts'));
    return;
  }

  const items: ConflictPick[] = conflicts.map((c) => ({
    label: `${c.type}:${c.localId}`,
    description: l10n('sync.conflictItem', { kind: c.kind, version: c.remoteVersion }),
    recordId: c.recordId,
  }));
  items.push({ label: `$(arrow-up) ${l10n('sync.useLocalAll')}`, bulk: 'local' });
  items.push({ label: `$(git-merge) ${l10n('sync.useMergeAll')}`, bulk: 'merge' });
  items.push({ label: `$(arrow-down) ${l10n('sync.useRemoteAll')}`, bulk: 'remote' });

  const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('sync.conflictPrompt'), ignoreFocusOut: true });
  if (!picked) return;

  if (picked.bulk) {
    const decision: 'local' | 'merge' | 'remote' = picked.bulk;
    for (const c of conflicts) {
      try {
        await session.resolveConflict(c.recordId, decision);
      } catch {
        // 单条失败（如 Use Remote 密文未就绪）保留该冲突，继续下一条。
      }
    }
    session.scheduleNow();
    return;
  }

  const decision = await vscode.window.showQuickPick(
    [
      { label: l10n('sync.useLocal'), value: 'local' },
      { label: l10n('sync.useMerge'), value: 'merge' },
      { label: l10n('sync.useRemote'), value: 'remote' },
      { label: l10n('sync.cancel'), value: 'cancel' },
    ],
    { placeHolder: l10n('sync.conflictDecision') },
  );
  if (!decision || decision.value === 'cancel') return;
  try {
    await session.resolveConflict(picked.recordId!, decision.value as 'local' | 'merge' | 'remote');
  } catch {
    // 单条失败（如 Use Remote 密文未就绪/远端版本未拉取）给用户可操作提示；
    // 下方 scheduleNow() 触发拉取补全密文/版本，供用户再次重试。
    vscode.window.showWarningMessage(l10n('sync.resolveConflictFailed'));
  }
  session.scheduleNow();
}