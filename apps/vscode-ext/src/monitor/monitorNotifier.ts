import * as vscode from 'vscode';
import { isZh, l10n } from '../i18n';
import { formatInterval, type MonitorCondition, type MonitorTask } from './monitorTypes';

/** 通知后的用户选择（由调用方执行：打开任务列表 / 暂停）。 */
export interface MonitorNotifierActions {
  view(task: MonitorTask): void;
  pause(task: MonitorTask): void | Promise<void>;
}

export function taskTitle(task: MonitorTask): string {
  const scope = [task.database, task.schema].filter(Boolean).join('.');
  return scope ? `${scope}.${task.table}` : task.table;
}

export function describeCondition(condition: MonitorCondition): string {
  switch (condition.type) {
    case 'anyChange': return l10n('monitor.condition.anyChange');
    case 'increaseBy': return l10n('monitor.condition.increaseBy', { n: condition.value });
    case 'decreaseBy': return l10n('monitor.condition.decreaseBy', { n: condition.value });
    case 'changePercent': return l10n('monitor.condition.changePercent', { n: condition.value });
    case 'above': return l10n('monitor.condition.above', { n: condition.value });
    case 'below': return l10n('monitor.condition.below', { n: condition.value });
  }
}

export function describeInterval(ms: number): string {
  return formatInterval(ms, isZh());
}

function formatDelta(previous: number | undefined, value: number): string {
  if (previous === undefined) return '';
  const delta = value - previous;
  return delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
}

/**
 * VS Code 通知：命中提醒条件 / 自动暂停。冷却期由调度器判断，这里只负责展示与按钮。
 */
export class MonitorNotifier {
  constructor(private readonly actions: MonitorNotifierActions) {}

  async hit(task: MonitorTask, previous: number | undefined, value: number): Promise<void> {
    const delta = formatDelta(previous, value);
    const message = l10n('monitor.notify.hit', {
      table: taskTitle(task),
      value: value.toLocaleString(),
      delta: delta ? ` (${delta})` : '',
      condition: describeCondition(task.condition),
    });
    const view = l10n('monitor.notify.view');
    const pause = l10n('monitor.notify.pause');
    const threshold = task.condition.type === 'above' || task.condition.type === 'below';
    const picked = threshold
      ? await vscode.window.showWarningMessage(message, view, pause)
      : await vscode.window.showInformationMessage(message, view, pause);
    if (picked === view) this.actions.view(task);
    else if (picked === pause) await this.actions.pause(task);
  }

  async autoPaused(task: MonitorTask): Promise<void> {
    const key = task.pausedReason === 'connectionChanged' ? 'monitor.notify.pausedConnection' : 'monitor.notify.pausedFailures';
    const message = l10n(key, { table: taskTitle(task), error: task.lastError ?? '' });
    const view = l10n('monitor.notify.view');
    const picked = await vscode.window.showWarningMessage(message, view);
    if (picked === view) this.actions.view(task);
  }
}
