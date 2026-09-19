import * as vscode from 'vscode';
import type { BackupScheduler } from '../schedule/backupScheduler';
import { l10n } from '../i18n';

/** 定时备份配置向导：已有计划则提供运行/修改/删除，否则询问周期与输出目录。 */
export async function configureBackupSchedule(
  scheduler: BackupScheduler,
  connId: string,
  database: string,
): Promise<void> {
  const existing = scheduler.getSchedules().find((s) => s.connId === connId && s.database === database);
  if (existing) {
    const action = await vscode.window.showQuickPick(
      [
        { label: l10n('backup.runNow'), value: 'run' },
        { label: l10n('backup.changeSchedule'), value: 'change' },
        { label: l10n('backup.removeSchedule'), value: 'remove' },
      ],
      { placeHolder: l10n('backup.scheduleInfo', { database, hours: Math.round(existing.intervalMs / 3600000), dir: existing.outputDir }) },
    );
    if (!action) return;
    if (action.value === 'run') {
      await scheduler.runNow(connId, database);
      return;
    }
    if (action.value === 'remove') {
      scheduler.removeSchedule(connId, database);
      vscode.window.showInformationMessage(l10n('backup.scheduleRemoved', { database }));
      return;
    }
  }

  const interval = await vscode.window.showQuickPick(
    [
      { label: l10n('backup.everyHour'), value: 3600000 },
      { label: l10n('backup.every6Hours'), value: 6 * 3600000 },
      { label: l10n('backup.everyDay'), value: 24 * 3600000 },
      { label: l10n('backup.everyWeek'), value: 7 * 24 * 3600000 },
    ],
    { placeHolder: l10n('backup.scheduleInterval', { database }) },
  );
  if (!interval) return;

  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: l10n('backup.selectFolder'),
    defaultUri: existing ? vscode.Uri.file(existing.outputDir) : undefined,
  });
  if (!folders?.length) return;

  const includeData = await vscode.window.showQuickPick(
    [
      { label: l10n('backup.schemaAndData'), value: true },
      { label: l10n('backup.schemaOnly'), value: false },
    ],
    { placeHolder: l10n('backup.contentsPlaceholder') },
  );
  if (!includeData) return;

  scheduler.addSchedule(connId, database, interval.value, folders[0].fsPath, includeData.value);
  vscode.window.showInformationMessage(
    l10n('backup.scheduleSet', { database, interval: interval.label.toLowerCase(), dir: folders[0].fsPath }),
  );
}