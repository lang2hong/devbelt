import * as vscode from 'vscode';
import { uniqueId } from './id';

export type AuditAction =
  | 'query_execute'
  | 'query_explain'
  | 'data_edit'
  | 'data_delete'
  | 'data_insert'
  | 'schema_change'
  | 'connection_open'
  | 'connection_close'
  | 'user_manage'
  | 'import_data'
  | 'export_data';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  connName: string;
  database?: string;
  sql?: string;
  rowCount?: number;
  costTime?: number;
  timestamp: number;
}

const MAX_ENTRIES = 1000;
const STORAGE_KEY = 'dbclient.auditLog';

export class AuditLogger {
  private static instance: AuditLogger | undefined;

  static init(state: vscode.Memento): AuditLogger {
    this.instance = new AuditLogger(state);
    return this.instance;
  }

  static getInstance(): AuditLogger {
    if (!AuditLogger.instance) throw new Error('AuditLogger not initialized');
    return AuditLogger.instance;
  }

  /**
   * 取实例，未初始化时返回 undefined。
   *
   * 供审计写入点使用：审计是旁路能力，拿不到 logger 不该让主流程失败，
   * 也不该逼每个调用点都 try/catch getInstance()。
   */
  static tryGet(): AuditLogger | undefined {
    return AuditLogger.instance;
  }

  /** 便捷写入：未初始化则静默跳过。 */
  static tryLog(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    AuditLogger.instance?.log(entry);
  }

  private constructor(private readonly state: vscode.Memento) {}

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const entries = this.getEntries();
    const record: AuditEntry = {
      ...entry,
      id: uniqueId('audit'),
      timestamp: Date.now(),
    };
    entries.unshift(record);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    this.state.update(STORAGE_KEY, entries);
  }

  getEntries(limit = 100, action?: AuditAction): AuditEntry[] {
    const entries = this.state.get<AuditEntry[]>(STORAGE_KEY, []);
    if (action) return entries.filter((e) => e.action === action).slice(0, limit);
    return entries.slice(0, limit);
  }

  clear(): void {
    this.state.update(STORAGE_KEY, []);
  }
}