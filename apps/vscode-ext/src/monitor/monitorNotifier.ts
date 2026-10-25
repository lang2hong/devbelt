import * as vscode from 'vscode';
import { isZh, l10n } from '../i18n';
import { formatInterval, monitorLabel, type MonitorCondition, type MonitorTask } from './monitorTypes';

/** 通知后的用户选择（由调用方执行：打开任务列表 / 暂停）。 */
export interface MonitorNotifierActions {
  view(task: MonitorTask): void;
  pause(task: MonitorTask): void | Promise<void>;
}

/** 任务标题：AI 给的显示名优先，其次「库.schema.表」。 */
export function taskTitle(task: Pick<MonitorTask, 'label' | 'database' | 'schema' | 'table'>): string {
  return monitorLabel(task);
}

/**
 * 提醒条件文案。新增行任务比较的是「本次新增行数」，不是和上一次的差值，
 * 所以 increaseBy / above / anyChange 都用「本次新增」措辞。
 */
export function describeCondition(condition: MonitorCondition, kind: MonitorTask['kind'] = 'rowCount'): string {
  if (kind === 'newRows') {
    switch (condition.type) {
      case 'anyChange': return l10n('monitor.condition.newRowsAny');
      case 'increaseBy': return l10n('monitor.condition.newRowsAtLeast', { n: condition.value });
      case 'above': return l10n('monitor.condition.newRowsAbove', { n: condition.value });
      default: return l10n('monitor.condition.newRowsAny');
    }
  }
  switch (condition.type) {
    case 'anyChange': return l10n('monitor.condition.anyChange');
    case 'increaseBy': return l10n('monitor.condition.increaseBy', { n: condition.value });
    case 'decreaseBy': return l10n('monitor.condition.decreaseBy', { n: condition.value });
    case 'changePercent': return l10n('monitor.condition.changePercent', { n: condition.value });
    case 'above': return l10n('monitor.condition.above', { n: condition.value });
    case 'below': return l10n('monitor.condition.below', { n: condition.value });
  }
}

/** 任务的提醒说明：指标任务前缀绑定列名。 */
export function describeTaskCondition(task: Pick<MonitorTask, 'kind' | 'condition' | 'watchColumn'>): string {
  const text = describeCondition(task.condition, task.kind);
  return task.kind === 'metric' && task.watchColumn ? `${task.watchColumn}: ${text}` : text;
}

export function describeInterval(ms: number): string {
  return formatInterval(ms, isZh());
}

function formatDelta(previous: number | undefined, value: number): string {
  if (previous === undefined) return '';
  const delta = value - previous;
  return delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
}

/** 通知正文：按任务类型分别描述（行数 / 指标列的值 / 本次新增行数）。 */
export function hitMessage(task: MonitorTask, previous: number | undefined, value: number): string {
  const title = taskTitle(task);
  const condition = describeTaskCondition(task);
  if (task.kind === 'newRows') {
    return l10n('monitor.notify.hitNewRows', { table: title, n: value.toLocaleString(), condition });
  }
  const delta = formatDelta(previous, value);
  if (task.kind === 'metric') {
    return l10n('monitor.notify.hitMetric', {
      table: title,
      column: task.watchColumn ?? '',
      value: value.toLocaleString(),
      delta: delta ? ` (${delta})` : '',
      condition,
    });
  }
  return l10n('monitor.notify.hit', { table: title, value: value.toLocaleString(), delta: delta ? ` (${delta})` : '', condition });
}

/**
 * VS Code 通知：命中提醒条件 / 自动暂停。冷却期由调度器判断，这里只负责展示与按钮。
 */
export class MonitorNotifier {
  constructor(private readonly actions: MonitorNotifierActions) {}

  async hit(task: MonitorTask, previous: number | undefined, value: number): Promise<void> {
    const message = hitMessage(task, previous, value);
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
