import * as vscode from 'vscode';
import { createWriteStream } from 'fs';
import { mkdir, rename, rm } from 'fs/promises';
import { once } from 'events';
import { BackupService } from '@devkit/db-core';
import { ConnectionManager } from '../connection/connectionManager';
import type { ConnectionStore } from '@devkit/db-host/connection/connectionStore';

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
  private readonly storageKey = 'devbelt.backup.schedules';

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
    // 文件名带日期 + 时间：只到「日」时，同一天多次/每小时备份会互相覆盖，历史静默丢失。
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = `${entry.database}_${stamp}.sql`;
    const uri = vscode.Uri.joinPath(vscode.Uri.file(entry.outputDir), fileName);

    // 流式写盘：dump 不再整份驻留内存，内存占用只与单表数据量相关。
    // 先写 .tmp 再原子改名：中途失败不会留下半截 dump 被当成有效备份。
    await mkdir(entry.outputDir, { recursive: true });
    const tmpPath = `${uri.fsPath}.tmp`;
    const stream = createWriteStream(tmpPath, { encoding: 'utf8' });
    const streamError = new Promise<never>((_, reject) => stream.once('error', reject));
    try {
      await Promise.race([
        BackupService.writeDatabaseDump(
          session.query, session.metadata, session.table, entry.database,
          async (chunk) => {
            if (!stream.write(chunk)) await once(stream, 'drain');
          },
          { includeData: entry.includeData },
        ),
        streamError,
      ]);
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.once('error', reject);
      });
      await rename(tmpPath, uri.fsPath);
    } catch (err) {
      stream.destroy();
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    vscode.window.showInformationMessage(`Backup complete: ${fileName}`);
  }
}