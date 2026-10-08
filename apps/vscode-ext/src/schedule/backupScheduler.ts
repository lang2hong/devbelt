import * as vscode from 'vscode';
import { createWriteStream } from 'fs';
import { mkdir, rename, rm } from 'fs/promises';
import { once } from 'events';
import { BackupService } from '@devbelt/db-core';
import { ConnectionManager } from '../connection/connectionManager';
import { diagWarn } from '../utils/diagnostics';
import type { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import { l10n } from '../i18n';
import { backupFileName } from './backupFileName';

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
    void this.state.update(this.storageKey, entries).then(undefined, (e) => diagWarn('backup schedule persist failed', String(e)));
    this.stopTimer(entry.id);
    this.scheduleEntry(entry);
  }

  removeSchedule(connId: string, database: string): void {
    const key = `${connId}:${database}`;
    this.stopTimer(key);
    const entries = this.state.get<ScheduleEntry[]>(this.storageKey, [])
      .filter((e) => e.connId !== connId || e.database !== database);
    void this.state.update(this.storageKey, entries).then(undefined, (e) => diagWarn('backup schedule persist failed', String(e)));
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
        vscode.window.showErrorMessage(l10n('backup.failed', { message: (err as Error).message }));
      }
    }, entry.intervalMs);
    this.timers.set(key, timer);
  }

  private async executeBackup(entry: ScheduleEntry): Promise<void> {
    const conn = this.store.get(entry.connId);
    if (!conn) return;
    const session = await this.manager.connectSql(conn, entry.database);
    // 文件名带日期 + 时间：只到「日」时，同一天多次/每小时备份会互相覆盖，历史静默丢失。
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await mkdir(entry.outputDir, { recursive: true });
    // PG 多 schema：**每个 schema 一个文件**（dump 目标相对，不含 schema 限定）——
    // 这样一个文件可恢复到任意目标 schema（restore 设 search_path），不会把源 schema 写死。
    const schemas: (string | undefined)[] = conn.dbType === 'PG'
      ? (await session.metadata.getSchemas())
      : [undefined];
    const written: string[] = [];
    for (const schema of schemas) {
      const fileName = backupFileName(entry.database, stamp, schema);
      const uri = vscode.Uri.joinPath(vscode.Uri.file(entry.outputDir), fileName);
      // 流式写盘：dump 不再整份驻留内存；先写 .tmp 再原子改名，中途失败不留半截 dump。
      const tmpPath = `${uri.fsPath}.tmp`;
      // 备份可能含敏感数据：.tmp 以 0600 创建（改名后权限保留）。
      const stream = createWriteStream(tmpPath, { encoding: 'utf8', mode: 0o600 });
      const streamError = new Promise<never>((_, reject) => stream.once('error', reject));
      const write = async (chunk: string): Promise<void> => {
        if (!stream.write(chunk)) await once(stream, 'drain');
      };
      try {
        await Promise.race([
          BackupService.writeDatabaseDump(
            session.query, session.metadata, session.table, entry.database,
            write,
            { includeData: entry.includeData, schema },
          ),
          streamError,
        ]);
        await new Promise<void>((resolve, reject) => {
          stream.end(() => resolve());
          stream.once('error', reject);
        });
        await rename(tmpPath, uri.fsPath);
        written.push(fileName);
      } catch (err) {
        stream.destroy();
        await rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
    }
    vscode.window.showInformationMessage(l10n('backup.complete', { name: written.join(', ') }));
  }
}