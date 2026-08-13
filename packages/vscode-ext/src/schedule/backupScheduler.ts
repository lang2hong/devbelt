import * as vscode from 'vscode';
import { BackupService } from '@db-client/core';
import { ConnectionManager } from '../connection/connectionManager';
import type { ConnectionStore } from '../connection/connectionStore';

interface ScheduleEntry {
  id: string;
  connId: string;
  database: string;
  intervalMs: number;
  outputDir: string;
  includeData: boolean;
}

export class BackupScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly storageKey = 'dbclient.backup.schedules';

  constructor(
    private readonly manager: ConnectionManager,
    private readonly store: ConnectionStore,
    private readonly state: vscode.Memento,
  ) {}

  start(): void {
    const entries = this.state.get<ScheduleEntry[]>(this.storageKey, []);
    for (const entry of entries) {
      this.scheduleEntry(entry);
    }
  }

  dispose(): void {
    this.stop();
  }

  stop(): void {
    for (const [_id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  addSchedule(connId: string, database: string, intervalMs: number, outputDir: string, includeData = true): void {
    const entry: ScheduleEntry = { id: `${connId}:${database}`, connId, database, intervalMs, outputDir, includeData };
    const entries = this.state.get<ScheduleEntry[]>(this.storageKey, []);
    const existing = entries.findIndex((e) => e.id === entry.id);
    if (existing >= 0) {
      entries[existing] = entry;
    } else {
      entries.push(entry);
    }
    this.state.update(this.storageKey, entries);
    this.stopTimer(entry.id);
    this.scheduleEntry(entry);
  }

  removeSchedule(connId: string, database: string): void {
    const key = `${connId}:${database}`;
    this.stopTimer(key);
    const entries = this.state.get<ScheduleEntry[]>(this.storageKey, [])
      .filter((e) => e.connId !== connId || e.database !== database);
    this.state.update(this.storageKey, entries);
  }

  getSchedules(): ScheduleEntry[] {
    return this.state.get<ScheduleEntry[]>(this.storageKey, []);
  }

  async runNow(connId: string, database: string): Promise<void> {
    const entry = this.getSchedules().find((e) => e.connId === connId && e.database === database);
    if (!entry) throw new Error('No schedule found for this database');
    await this.executeBackup(entry);
  }

  private stopTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) { clearInterval(timer); this.timers.delete(key); }
  }

  private scheduleEntry(entry: ScheduleEntry): void {
    const key = entry.id;
    if (this.timers.has(key)) return;
    const timer = setInterval(async () => {
      try {
        await this.executeBackup(entry);
      } catch (err) {
        vscode.window.showErrorMessage(`Backup failed: ${(err as Error).message}`);
      }
    }, entry.intervalMs);
    this.timers.set(key, timer);
  }

  private async executeBackup(entry: ScheduleEntry): Promise<void> {
    const conn = this.store.get(entry.connId);
    if (!conn) return;
    const session = await this.manager.connect(conn);
    const content = await BackupService.databaseDump(
      session.query, session.metadata, session.table,
      entry.database, { includeData: entry.includeData },
    );
    const fileName = `${entry.database}_${new Date().toISOString().slice(0, 10)}.sql`;
    const uri = vscode.Uri.joinPath(vscode.Uri.file(entry.outputDir), fileName);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`Backup complete: ${fileName}`);
  }
}