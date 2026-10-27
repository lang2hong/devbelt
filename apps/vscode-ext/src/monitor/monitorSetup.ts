import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import type { ConnectionStore, SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { eventBus, ConnectionChangedEvent } from '@devbelt/db-host/utils/event';
import type { ConnectionManager } from '../connection/connectionManager';
import { AuditLogger } from '../utils/auditLogger';
import { diagWarn } from '../utils/diagnostics';
import { l10n } from '../i18n';
import { createRowCountMonitor, showMonitorTasks, type MonitorCommandDeps, type MonitorTableNode } from './monitorCommands';
import { MonitorBridge, type MonitorTaskView } from './monitorBridge';
import { MonitorService } from './monitorService';
import { describeTaskCondition } from './monitorNotifier';
import { MonitorExecutor } from './monitorExecutor';
import { MonitorLock } from './monitorLock';
import { MonitorNotifier } from './monitorNotifier';
import { MonitorNotOwnerError, MonitorScheduler } from './monitorScheduler';
import { describeTableReadOnly } from './monitorExecutor';
import { MonitorStatusBar } from './monitorStatusBar';
import { MonitorStore } from './monitorStore';
import { connectionFingerprint, DEFAULT_COOLDOWN_MS, DEFAULT_MAX_TASKS, monitorLabel, type MonitorTask } from './monitorTypes';

const HEARTBEAT_MS = 15_000;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('devbelt.ai.monitor');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * P13 第一批装配：存储 → 锁 → 执行器 → 调度器 → 通知 / 状态栏 / 命令。
 *
 * 所有任务在启动时置为暂停；只有持锁窗口执行；连接被删除或改动时相关任务暂停。
 */
export interface MonitorSetupDeps {
  store: ConnectionStore;
  manager: ConnectionManager;
  /** 「让 AI 帮我设置监控」：打开 AI Chat，切到该连接 / 库，打开 Agent，预填输入。 */
  openAiSetup?(node: MonitorTableNode): void;
}

export function registerMonitor(context: vscode.ExtensionContext, deps: MonitorSetupDeps): MonitorService {
  const storageRoot = context.globalStorageUri.fsPath;
  const store = new MonitorStore(storageRoot);
  const lock = new MonitorLock({ dir: store.directory, ownerId: randomBytes(8).toString('hex'), heartbeatMs: HEARTBEAT_MS });
  const statusBar = new MonitorStatusBar();

  const fingerprint = (conn: SavedConnection, database: string | undefined): string =>
    connectionFingerprint(conn, database, sha256);

  const executor = new MonitorExecutor({
    dbTypeOf: (task) => deps.store.get(task.connId)?.dbType as string | undefined,
    timeoutMs: () => Math.max(5, config().get<number>('queryTimeoutSeconds', 30)) * 1000,
    openSession: async (task) => {
      const conn = deps.store.get(task.connId);
      if (!conn) throw new Error('connection not found');
      const opened = await deps.manager.openIsolatedSql(conn, task.database);
      return { session: opened.session as never, close: opened.close };
    },
  });

  let notifier: MonitorNotifier | undefined;
  const refreshStatus = (): void => {
    statusBar.update(scheduler.runningCount(), scheduler.list().length, lock.isHeld);
  };

  const changeListeners = new Set<() => void>();
  const emitChanged = (): void => {
    for (const listener of [...changeListeners]) {
      try { listener(); } catch { /* 面板已关闭 */ }
    }
  };

  const scheduler: MonitorScheduler = new MonitorScheduler({
    store,
    run: (task) => executor.run(task),
    canExecute: () => lock.isHeld && config().get<boolean>('enabled', true),
    isOwner: () => lock.isHeld,
    connectionValid: (task) => {
      const conn = deps.store.get(task.connId);
      if (!conn) return false;
      return !task.connFingerprint || task.connFingerprint === fingerprint(conn, task.database);
    },
    cooldownMs: () => Math.max(0, config().get<number>('notifyCooldownMinutes', DEFAULT_COOLDOWN_MS / 60_000)) * 60_000,
    onHit: (task, previous, value) => void notifier?.hit(task, previous, value),
    onAutoPaused: (task) => {
      audit('autoPause', task);
      void notifier?.autoPaused(task);
    },
    onChanged: () => {
      refreshStatus();
      emitChanged();
    },
    onRun: () => emitChanged(),
    onRunStart: () => emitChanged(),
  });

  const audit = (action: 'create' | 'remove' | 'pause' | 'resume' | 'autoPause' | 'edit', task: MonitorTask): void => {
    const conn = deps.store.get(task.connId);
    AuditLogger.tryLog({
      action: 'monitor_task',
      connName: conn?.name || conn?.host || task.connId,
      ...(task.database ? { database: task.database } : {}),
      ...(task.schema ? { schema: task.schema } : {}),
      // 只记操作与目标，不记任何行内容。
      sql: `${action}: ${task.kind} ${task.database ? `${task.database}.` : ''}${task.schema ? `${task.schema}.` : ''}${task.table}${task.label ? ` "${task.label}"` : ''}${task.origin === 'ai' ? ' (ai)' : ''}`,
    });
  };

  const commandDeps: MonitorCommandDeps = {
    scheduler,
    getConnection: (id) => deps.store.get(id),
    fingerprint,
    allowProduction: () => config().get<boolean>('allowProduction', false),
    maxTasks: () => Math.max(1, config().get<number>('maxTasks', DEFAULT_MAX_TASKS)),
    enabled: () => config().get<boolean>('enabled', true),
    executing: () => lock.isHeld,
    audit,
  };

  const service = new MonitorService({
    scheduler,
    executor,
    getConnection: (id) => deps.store.get(id),
    fingerprint,
    allowProduction: commandDeps.allowProduction,
    maxTasks: commandDeps.maxTasks,
    enabled: commandDeps.enabled,
    // 走执行器的只读会话（search_path 已按 schema 设置）读元数据，带超时、与定时检查串行。
    describe: (conn, database, schema, table) => executor.trial(
      { connId: conn.id, ...(database ? { database } : {}), ...(schema ? { schema } : {}) },
      (session) => describeTableReadOnly(session, String(conn.dbType), database, schema, table),
    ),
    isOwner: () => lock.isHeld,
    audit,
  });

  const view = (task: MonitorTask): MonitorTaskView => {
    const conn = deps.store.get(task.connId);
    return {
      id: task.id,
      kind: task.kind,
      label: monitorLabel(task),
      connName: conn?.name || conn?.host || '',
      table: task.table,
      ...(task.database ? { database: task.database } : {}),
      ...(task.schema ? { schema: task.schema } : {}),
      status: task.status,
      ...(task.pausedReason ? { pausedReason: task.pausedReason } : {}),
      createdAt: task.createdAt,
      ...(scheduler.nextRun(task.id) !== undefined ? { nextRunAt: scheduler.nextRun(task.id)! } : {}),
      ...(scheduler.isExecuting(task.id) ? { running: true } : {}),
      ...(task.lastNotifiedAt ? { lastNotifiedAt: task.lastNotifiedAt } : {}),
      consecutiveFailures: task.consecutiveFailures,
      intervalMs: task.intervalMs,
      condition: task.condition,
      conditionText: describeTaskCondition(task),
      ...(task.lastValue !== undefined ? { lastValue: task.lastValue } : {}),
      ...(task.lastValues ? { lastValues: task.lastValues } : {}),
      ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}),
      ...(task.lastError ? { lastError: task.lastError } : {}),
      ...(task.columns ? { columns: task.columns } : {}),
      ...(task.watchColumn ? { watchColumn: task.watchColumn } : {}),
      ...(task.cursorColumn ? { cursorColumn: task.cursorColumn } : {}),
      ...(task.sql ? { sql: task.sql } : {}),
    };
  };

  MonitorBridge.init({
    list: () => scheduler.list().map(view),
    detail: async (id) => {
      const task = scheduler.get(id);
      if (!task) return undefined;
      const points = (await store.readHistory(id)).slice(-200);
      const rows = scheduler.latestRows(id);
      return { task: view(task), points, ...(rows ? { rows } : {}) };
    },
    action: async (id, action) => {
      const task = scheduler.get(id);
      if (!task) return;
      if (!lock.isHeld) throw new MonitorNotOwnerError();
      if (action === 'resume') { await scheduler.resume(id); audit('resume', task); }
      else if (action === 'pause') { await scheduler.pause(id); audit('pause', task); }
      else if (action === 'runNow') { if (lock.isHeld) await scheduler.runNow(id); }
      else if (action === 'remove') { await scheduler.remove(id); audit('remove', task); }
    },
    resumeAll: async () => {
      if (!lock.isHeld) throw new MonitorNotOwnerError();
      await scheduler.resumeAll();
      for (const task of scheduler.list()) if (task.status === 'running') audit('resume', task);
    },
    takeOver: async () => {
      if (!(await lock.forceAcquire())) return false;
      // 以磁盘为准重新加载并把任务全部暂停：不在用户没看到时开始查询。
      await scheduler.takeOver();
      refreshStatus();
      emitChanged();
      return true;
    },
    confirm: async (proposalId, overrides) => {
      const result = await service.confirm(proposalId, overrides ?? {});
      return result.ok ? { ok: true, task: view(result.task) } : result;
    },
    edit: async (id, patch) => {
      if (!lock.isHeld) throw new MonitorNotOwnerError();
      const result = await service.edit(id, patch);
      return result.ok ? { ok: true, task: view(result.task) } : result;
    },
    discard: (proposalId) => service.discard(proposalId),
    executing: () => lock.isHeld,
    onChanged: (listener) => {
      changeListeners.add(listener);
      return { dispose: () => changeListeners.delete(listener) };
    },
    describeProposal: (p) => ({
      id: p.id,
      kind: p.kind,
      label: p.label ?? monitorLabel(p),
      connName: p.connName,
      table: p.table,
      ...(p.database ? { database: p.database } : {}),
      ...(p.schema ? { schema: p.schema } : {}),
      intervalMinutes: Math.round(p.intervalMs / 60_000),
      ...(p.condition ? { condition: p.condition } : {}),
      conditionText: describeTaskCondition(p),
      ...(p.sql ? { sql: p.sql } : {}),
      ...(p.columns ? { columns: p.columns } : {}),
      ...(p.watchColumn ? { watchColumn: p.watchColumn } : {}),
      ...(p.preview ? { preview: p.preview } : {}),
      ...(p.cursorColumn ? { cursorColumn: p.cursorColumn } : {}),
      warnings: p.warnings.map((w) => ({ code: w.code, ...(w.detail ? { detail: w.detail } : {}) })),
    }),
  });

  notifier = new MonitorNotifier({
    view: (task) => void vscode.commands.executeCommand('devbelt.monitor.tasks', task.id),
    pause: async (task) => {
      if (!lock.isHeld) return;
      await scheduler.pause(task.id);
      audit('pause', task);
    },
  });

  // 锁：获取 → 心跳续期。拿到锁（首次或原窗口关闭后接手）时以磁盘为准重新加载；
  // 失去锁时停掉本地计时器；不持锁时定期从磁盘刷新显示。
  let started = false;
  const heartbeat = async (): Promise<void> => {
    try {
      const before = lock.isHeld;
      await lock.tryAcquire();
      if (!started) return;
      if (!before && lock.isHeld) {
        const paused = await scheduler.takeOver();
        // 原执行窗口关闭后接手：任务已暂停，提示一次，避免用户以为监控还在跑。
        if (paused > 0) {
          const open = l10n('monitor.notify.view');
          void vscode.window.showInformationMessage(l10n('monitor.notify.handover', { n: paused }), open)
            .then((picked) => { if (picked === open) void vscode.commands.executeCommand('devbelt.monitor.tasks'); });
        }
      }
      else if (before && !lock.isHeld) {
        scheduler.relinquish();
        // 另一个窗口主动接管：明确告诉用户这里已经停止执行，避免以为监控还在跑。
        void vscode.window.showInformationMessage(l10n('monitor.notify.ownerMoved'));
      }
      else if (!lock.isHeld) await scheduler.reload();
      if (before !== lock.isHeld) refreshStatus();
    } catch (err) {
      diagWarn('monitor lock heartbeat failed', String(err));
    }
  };
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);

  void (async () => {
    await heartbeat();
    await scheduler.start();
    started = true;
    refreshStatus();
  })().catch((err) => diagWarn('monitor start failed', String(err)));

  context.subscriptions.push(
    statusBar,
    eventBus.subscribe(ConnectionChangedEvent, (e) => {
      if (e.kind !== 'connection') return;
      if (e.id) executor.closeConnection(e.id);
      void scheduler.revalidateConnections();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devbelt.ai.monitor')) refreshStatus();
    }),
    vscode.commands.registerCommand('devbelt.monitor.rowCount', (node?: MonitorTableNode) => createRowCountMonitor(commandDeps, node)),
    vscode.commands.registerCommand('devbelt.monitor.tasks', async (focusId?: unknown) => {
      // 优先在 AI Chat 的「后台任务」抽屉里打开；AI 不可用时退回 QuickPick。
      const opened = await vscode.commands.executeCommand<boolean>('devbelt.ai.openMonitor', typeof focusId === 'string' ? focusId : undefined)
        .then((r) => r === true, () => false);
      if (!opened) await showMonitorTasks(commandDeps, typeof focusId === 'string' ? focusId : undefined);
    }),
    vscode.commands.registerCommand('devbelt.monitor.aiSetup', (node?: MonitorTableNode) => {
      if (!node?.conn) return;
      if (!commandDeps.enabled()) {
        void vscode.window.showInformationMessage(l10n('monitor.disabled'));
        return;
      }
      deps.openAiSetup?.(node);
    }),
    vscode.commands.registerCommand('devbelt.monitor.resumeAll', async () => {
      if (!lock.isHeld) {
        void vscode.window.showInformationMessage(l10n('monitor.list.otherWindowAction'));
        return;
      }
      await scheduler.resumeAll();
      for (const task of scheduler.list()) if (task.status === 'running') audit('resume', task);
    }),
    {
      dispose: () => {
        clearInterval(heartbeatTimer);
        changeListeners.clear();
        MonitorBridge.reset();
        scheduler.dispose();
        executor.dispose();
        void lock.release();
      },
    },
  );
  return service;
}
