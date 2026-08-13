import * as vscode from 'vscode';

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

  private constructor(private readonly state: vscode.Memento) {}

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const entries = this.getEntries();
    const record: AuditEntry = {
      ...entry,
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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