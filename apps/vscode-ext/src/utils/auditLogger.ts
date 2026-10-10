import * as vscode from 'vscode';
import { diagWarn } from './diagnostics';
import { uniqueId } from '@devbelt/db-host/utils/id';

export type AuditAction =
  | 'query_execute'
  | 'query_explain'
  | 'data_edit'
  | 'data_delete'
  | 'data_insert'
  | 'data_sync'
  | 'schema_change'
  | 'connection_open'
  | 'connection_close'
  | 'user_manage'
  | 'import_data'
  | 'restore_data'
  | 'export_data'
  | 'process_kill'
  /** P7：Redis 写/危险命令。 */
  | 'redis_command'
  /** P8：Elasticsearch REST 写请求（method/path，不含 body）。 */
  | 'es_rest';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  connName: string;
  database?: string;
  /** PG 命名空间（多 schema 下区分同一库内的写入目标）。 */
  schema?: string;
  sql?: string;
  rowCount?: number;
  costTime?: number;
  timestamp: number;
}

const MAX_ENTRIES = 1000;
const STORAGE_KEY = 'devbelt.auditLog';

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
    void this.state.update(STORAGE_KEY, entries).then(undefined, (e) => diagWarn('audit persist failed', String(e)));
  }

  getEntries(limit = MAX_ENTRIES, action?: AuditAction): AuditEntry[] {
    const entries = this.state.get<AuditEntry[]>(STORAGE_KEY, []);
    if (action) return entries.filter((e) => e.action === action).slice(0, limit);
    return entries.slice(0, limit);
  }

  clear(): void {
    this.state.update(STORAGE_KEY, []);
  }
}