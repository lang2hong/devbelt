import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import type { ConnectionStore, SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { eventBus, ConnectionChangedEvent } from '@devbelt/db-host/utils/event';
import type { ConnectionManager } from '../connection/connectionManager';
import { AuditLogger } from '../utils/auditLogger';
import { diagWarn } from '../utils/diagnostics';
import { createRowCountMonitor, showMonitorTasks, type MonitorCommandDeps, type MonitorTableNode } from './monitorCommands';
import { MonitorExecutor } from './monitorExecutor';
import { MonitorLock } from './monitorLock';
import { MonitorNotifier, taskTitle } from './monitorNotifier';
import { MonitorScheduler } from './monitorScheduler';
import { MonitorStatusBar } from './monitorStatusBar';
import { MonitorStore } from './monitorStore';
import { connectionFingerprint, DEFAULT_COOLDOWN_MS, DEFAULT_MAX_TASKS, type MonitorTask } from './monitorTypes';

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
export function registerMonitor(context: vscode.ExtensionContext, deps: { store: ConnectionStore; manager: ConnectionManager }): void {
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

  const scheduler: MonitorScheduler = new MonitorScheduler({
    store,
    run: (task) => executor.run(task),
    canExecute: () => lock.isHeld && config().get<boolean>('enabled', true),
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
    onChanged: () => refreshStatus(),
  });

  const audit = (action: 'create' | 'remove' | 'pause' | 'resume' | 'autoPause', task: MonitorTask): void => {
    const conn = deps.store.get(task.connId);
    AuditLogger.tryLog({
      action: 'monitor_task',
      connName: conn?.name || conn?.host || task.connId,
      ...(task.database ? { database: task.database } : {}),
      ...(task.schema ? { schema: task.schema } : {}),
      // 只记操作与目标，不记任何行内容。
      sql: `${action}: ${task.kind} ${taskTitle(task)}`,
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

  notifier = new MonitorNotifier({
    view: (task) => void showMonitorTasks(commandDeps, task.id),
    pause: async (task) => {
      await scheduler.pause(task.id);
      audit('pause', task);
    },
  });

  // 锁：获取 → 心跳续期；失去锁时停止执行（调度器每次运行前检查 canExecute）。
  const heartbeat = async (): Promise<void> => {
    try {
      const before = lock.isHeld;
      await lock.tryAcquire();
      if (before !== lock.isHeld) refreshStatus();
    } catch (err) {
      diagWarn('monitor lock heartbeat failed', String(err));
    }
  };
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);

  void (async () => {
    await heartbeat();
    await scheduler.start();
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
    vscode.commands.registerCommand('devbelt.monitor.tasks', () => showMonitorTasks(commandDeps)),
    vscode.commands.registerCommand('devbelt.monitor.resumeAll', async () => {
      await scheduler.resumeAll();
      for (const task of scheduler.list()) if (task.status === 'running') audit('resume', task);
    }),
    {
      dispose: () => {
        clearInterval(heartbeatTimer);
        scheduler.dispose();
        executor.dispose();
        void lock.release();
      },
    },
  );
}
