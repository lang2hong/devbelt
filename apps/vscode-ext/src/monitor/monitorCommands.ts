import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { validateIdent, validateSchemaIdent } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { l10n } from '../i18n';
import { describeInterval, describeTaskCondition, taskTitle } from './monitorNotifier';
import type { MonitorScheduler } from './monitorScheduler';
import {
  checkCanCreate,
  defaultIntervalFor,
  estimatedRowsFromDescription,
  LARGE_TABLE_ROWS,
  type CreateRejectReason,
  type MonitorCondition,
  type MonitorTask,
} from './monitorTypes';

/** 右键表节点传入的最小信息（DbTreeNode 结构性满足）。 */
export interface MonitorTableNode {
  label: string;
  conn?: SavedConnection;
  database?: string;
  schema?: string;
  /** 树节点描述（含估算行数 `"<n> rows"`；MySQL TABLE_ROWS / PG reltuples，SQLite 无）。 */
  description?: unknown;
}

export interface MonitorCommandDeps {
  scheduler: MonitorScheduler;
  getConnection(id: string): SavedConnection | undefined;
  fingerprint(conn: SavedConnection, database: string | undefined): string;
  allowProduction(): boolean;
  maxTasks(): number;
  enabled(): boolean;
  /** 本窗口是否在执行（另一窗口持锁时只显示）。 */
  executing(): boolean;
  audit(action: 'create' | 'remove' | 'pause' | 'resume', task: MonitorTask): void;
}

const INTERVAL_CHOICES_MIN = [1, 5, 15, 30, 60, 360, 1440];

function rejectMessage(reason: CreateRejectReason): string {
  return l10n(`monitor.reject.${reason}`);
}

/** 右键「监控行数变化…」：选间隔 → 选提醒条件 → 创建并立即跑一次基线。不调用模型。 */
export async function createRowCountMonitor(deps: MonitorCommandDeps, node: MonitorTableNode | undefined): Promise<void> {
  if (!deps.enabled()) {
    void vscode.window.showInformationMessage(l10n('monitor.disabled'));
    return;
  }
  const conn = node?.conn;
  if (!node || !conn) return;
  const table = node.label;
  try {
    validateIdent(table);
    if (node.schema) validateSchemaIdent(node.schema);
  } catch {
    void vscode.window.showErrorMessage(l10n('monitor.reject.identifier', { table }));
    return;
  }
  if (!deps.executing()) {
    void vscode.window.showInformationMessage(l10n('monitor.list.otherWindowAction'));
    return;
  }
  const reason = checkCanCreate(
    {
      dbType: String(conn.dbType),
      production: conn.environment === 'production',
      connId: conn.id,
      ...(node.database ? { database: node.database } : {}),
      ...(node.schema ? { schema: node.schema } : {}),
      table,
      kind: 'rowCount',
    },
    deps.scheduler.list(),
    { allowProduction: deps.allowProduction(), maxTasks: deps.maxTasks() },
  );
  if (reason) {
    void vscode.window.showWarningMessage(rejectMessage(reason));
    return;
  }

  const estimated = estimatedRowsFromDescription(node.description);
  const large = estimated !== undefined && estimated > LARGE_TABLE_ROWS;
  const defaultMs = defaultIntervalFor(estimated);
  const intervalItems = INTERVAL_CHOICES_MIN.map((minutes) => ({
    label: describeInterval(minutes * 60_000),
    ms: minutes * 60_000,
    ...(minutes * 60_000 === defaultMs ? { description: l10n('monitor.pick.recommended') } : {}),
  }));
  intervalItems.sort((a, b) => (a.ms === defaultMs ? -1 : b.ms === defaultMs ? 1 : 0));
  const interval = await vscode.window.showQuickPick(intervalItems, {
    title: l10n('monitor.pick.intervalTitle', { table }),
    placeHolder: large
      ? l10n('monitor.pick.largeTable', { rows: Math.round(estimated!).toLocaleString() })
      : l10n('monitor.pick.intervalHint'),
    ignoreFocusOut: true,
  });
  if (!interval) return;

  const condition = await pickCondition(table);
  if (!condition) return;

  const task: MonitorTask = {
    id: `m${Date.now().toString(36)}${randomBytes(4).toString('hex')}`,
    kind: 'rowCount',
    connId: conn.id,
    ...(node.database ? { database: node.database } : {}),
    ...(node.schema ? { schema: node.schema } : {}),
    table,
    intervalMs: interval.ms,
    condition,
    status: 'running',
    createdAt: Date.now(),
    consecutiveFailures: 0,
    connFingerprint: deps.fingerprint(conn, node.database),
  };
  await deps.scheduler.add(task);
  deps.audit('create', task);
  const created = deps.scheduler.get(task.id);
  const baseline = created?.lastValue;
  const message = created?.lastError
    ? l10n('monitor.created.failed', { table: taskTitle(task), error: created.lastError })
    : !deps.executing()
      ? l10n('monitor.created.otherWindow', { table: taskTitle(task) })
      : l10n('monitor.created', {
        table: taskTitle(task),
        value: baseline !== undefined ? baseline.toLocaleString() : '—',
        interval: describeInterval(task.intervalMs),
      });
  const open = l10n('monitor.notify.view');
  const picked = created?.lastError
    ? await vscode.window.showWarningMessage(message, open)
    : await vscode.window.showInformationMessage(message, open);
  if (picked === open) await vscode.commands.executeCommand('devbelt.monitor.tasks');
}

async function pickCondition(table: string): Promise<MonitorCondition | undefined> {
  type Kind = MonitorCondition['type'];
  type ConditionItem = vscode.QuickPickItem & { cond: Kind };
  const items: ConditionItem[] = [
    { label: l10n('monitor.pick.cond.anyChange'), cond: 'anyChange' },
    { label: l10n('monitor.pick.cond.increaseBy'), cond: 'increaseBy' },
    { label: l10n('monitor.pick.cond.decreaseBy'), cond: 'decreaseBy' },
    { label: l10n('monitor.pick.cond.changePercent'), cond: 'changePercent' },
    { label: l10n('monitor.pick.cond.above'), cond: 'above' },
    { label: l10n('monitor.pick.cond.below'), cond: 'below' },
  ];
  const picked = await vscode.window.showQuickPick<ConditionItem>(items, {
    title: l10n('monitor.pick.conditionTitle', { table }),
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  if (picked.cond === 'anyChange') return { type: 'anyChange' };
  const percent = picked.cond === 'changePercent';
  const raw = await vscode.window.showInputBox({
    title: picked.label,
    prompt: percent ? l10n('monitor.pick.percentPrompt') : l10n('monitor.pick.valuePrompt'),
    value: percent ? '10' : '1',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v);
      if (!/^\s*\d+(\.\d+)?\s*$/.test(v) || !Number.isFinite(n)) return l10n('monitor.pick.invalidNumber');
      if (picked.cond !== 'above' && picked.cond !== 'below' && n <= 0) return l10n('monitor.pick.positive');
      return undefined;
    },
  });
  if (raw === undefined) return undefined;
  return { type: picked.cond, value: Number(raw) } as MonitorCondition;
}

function statusIcon(task: MonitorTask): string {
  if (task.status === 'running') return '$(pulse)';
  if (task.status === 'error') return '$(warning)';
  return '$(debug-pause)';
}

/** 最近一次结果的文案：行数 / 指标列的值 / 本次新增行数。 */
export function lastResultText(task: MonitorTask, time: string): string {
  if (task.lastError) return l10n('monitor.list.lastError', { time, error: task.lastError });
  const value = task.lastValue?.toLocaleString() ?? '—';
  if (task.kind === 'newRows') return l10n('monitor.ui.lastNewRows', { time, n: value });
  if (task.kind === 'metric') return l10n('monitor.ui.lastMetric', { time, column: task.watchColumn ?? '', value });
  return l10n('monitor.list.lastValue', { time, value });
}

function taskDetail(task: MonitorTask): string {
  const parts = [describeInterval(task.intervalMs), describeTaskCondition(task)];
  if (task.lastRunAt) parts.push(lastResultText(task, new Date(task.lastRunAt).toLocaleTimeString()));
  if (task.status === 'paused' && task.pausedReason) parts.push(l10n(`monitor.list.paused.${task.pausedReason}`));
  return parts.join(' · ');
}

/** 「后台任务」：QuickPick 列出任务，选中后选操作（继续 / 暂停 / 立即运行 / 删除）。 */
export async function showMonitorTasks(deps: MonitorCommandDeps, focusId?: string): Promise<void> {
  const tasks = deps.scheduler.list();
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(l10n('monitor.list.empty'));
    return;
  }
  const paused = tasks.filter((t) => t.status === 'paused').length;
  type Item = vscode.QuickPickItem & { taskId?: string; resumeAll?: true };
  const items: Item[] = [];
  if (paused > 0) items.push({ label: `$(play) ${l10n('monitor.list.resumeAll', { n: paused })}`, resumeAll: true });
  for (const task of tasks) {
    const conn = deps.getConnection(task.connId);
    items.push({
      label: `${statusIcon(task)} ${taskTitle(task)}`,
      description: conn?.name ?? l10n('monitor.list.connectionMissing'),
      detail: taskDetail(task),
      taskId: task.id,
      ...(task.id === focusId ? { picked: true } : {}),
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: deps.executing() ? l10n('monitor.list.title') : l10n('monitor.list.titleOtherWindow'),
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked.resumeAll) {
    if (!deps.executing()) {
      void vscode.window.showInformationMessage(l10n('monitor.list.otherWindowAction'));
      return;
    }
    await deps.scheduler.resumeAll();
    for (const task of deps.scheduler.list()) if (task.status === 'running') deps.audit('resume', task);
    return;
  }
  const task = picked.taskId ? deps.scheduler.get(picked.taskId) : undefined;
  if (!task) return;
  await taskActions(deps, task);
}

async function taskActions(deps: MonitorCommandDeps, task: MonitorTask): Promise<void> {
  // 只有执行任务的窗口能修改任务；其他窗口只看。
  if (!deps.executing()) {
    void vscode.window.showInformationMessage(l10n('monitor.list.otherWindowAction'));
    return;
  }
  type Action = 'resume' | 'pause' | 'runNow' | 'remove';
  const actions: Array<vscode.QuickPickItem & { action: Action }> = [];
  if (task.status === 'paused') actions.push({ label: `$(play) ${l10n('monitor.action.resume')}`, action: 'resume' });
  else actions.push({ label: `$(debug-pause) ${l10n('monitor.action.pause')}`, action: 'pause' });
  actions.push(
    { label: `$(refresh) ${l10n('monitor.action.runNow')}`, action: 'runNow' },
    { label: `$(trash) ${l10n('monitor.action.remove')}`, action: 'remove' },
  );
  const picked = await vscode.window.showQuickPick(actions, { title: taskTitle(task), placeHolder: taskDetail(task) });
  if (!picked) return;
  switch (picked.action) {
    case 'resume':
      await deps.scheduler.resume(task.id);
      deps.audit('resume', task);
      break;
    case 'pause':
      await deps.scheduler.pause(task.id);
      deps.audit('pause', task);
      break;
    case 'runNow':
      if (!deps.executing()) {
        void vscode.window.showInformationMessage(l10n('monitor.list.otherWindowAction'));
        return;
      }
      await deps.scheduler.runNow(task.id);
      await showMonitorTasks(deps, task.id);
      break;
    case 'remove': {
      const ok = l10n('monitor.action.remove');
      const confirmed = await vscode.window.showWarningMessage(l10n('monitor.remove.confirm', { table: taskTitle(task) }), { modal: true }, ok);
      if (confirmed !== ok) return;
      await deps.scheduler.remove(task.id);
      deps.audit('remove', task);
      break;
    }
  }
}
