import type * as vscode from 'vscode';

/**
 * 连接级 AI 上下文存储（P9 S3）。
 *
 * 两种自由文本，**只存本地 Memento**、不进 SavedConnection/E2EE 同步：
 * - 域上下文（业务术语表）：`devbelt.ai.domainContext.<connId>`；
 * - 默认业务指令（如"金额单位是分"）：`devbelt.ai.defaultDirectives.<connId>`。
 *
 * 长度受控（单值 ≤ 2000 字符）：Memento 是同步落盘的 JSON，放任超长文本会拖慢
 * 启动读写；超限截断而不是拒绝（用户输入不应因存储细节丢失）。
 */
const MAX_TEXT_CHARS = 2000;

export const DOMAIN_CONTEXT_PREFIX = 'devbelt.ai.domainContext.';
export const DEFAULT_DIRECTIVES_PREFIX = 'devbelt.ai.defaultDirectives.';
export const LAST_SCOPE_PREFIX = 'devbelt.ai.lastScope.';
export const SELECTED_TABLES_PREFIX = 'devbelt.ai.selectedTables.';
export const SCHEMA_NOTES_PREFIX = 'devbelt.ai.schemaNotes.';

/** 表/列临时说明与样例（S7e；键：`devbelt.ai.schemaNotes.<connId>.<库>`）。 */
export interface ColumnNote {
  note?: string;
  sample?: string;
}

export interface TableNote {
  note?: string;
  columns?: Record<string, ColumnNote>;
}

export interface SchemaNotes {
  tables: Record<string, TableNote>;
}

const TABLE_NOTE_MAX_CHARS = 200;
const COLUMN_NOTE_MAX_CHARS = 120;
const SAMPLE_MAX_CHARS = 200;
/** 单库注记上限：防 Memento 膨胀（超出保存被拒并提示）。 */
const MAX_COLUMN_ENTRIES = 500;

function clampNote(raw: unknown, maxChars: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const single = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!single) return undefined;
  return single.length > maxChars ? single.slice(0, maxChars - 1) + '…' : single;
}

/** 表级注记查找：精确 → 大小写不敏感兜底。 */
export function findTableNote(notes: SchemaNotes | undefined, table: string): TableNote | undefined {
  if (!notes) return undefined;
  if (notes.tables[table]) return notes.tables[table];
  const lower = table.toLowerCase();
  for (const [name, entry] of Object.entries(notes.tables)) {
    if (name.toLowerCase() === lower) return entry;
  }
  return undefined;
}

/** 列级注记查找：精确 → 大小写不敏感兜底。 */
export function findColumnNote(entry: TableNote | undefined, column: string): ColumnNote | undefined {
  if (!entry?.columns) return undefined;
  if (entry.columns[column]) return entry.columns[column];
  const lower = column.toLowerCase();
  for (const [name, note] of Object.entries(entry.columns)) {
    if (name.toLowerCase() === lower) return note;
  }
  return undefined;
}

/** 连接级"上次选择的作用域"（P9 S7a：库/逻辑库/索引；单选切换）。 */
export interface AiScopeRef {
  kind: 'database' | 'redis-db' | 'index';
  value: string;
}

function normalize(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  return trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed;
}

export class AiContextStore {
  constructor(private readonly memento: vscode.Memento) {}

  getDomainContext(connId: string): string {
    return normalize(this.memento.get<string>(`${DOMAIN_CONTEXT_PREFIX}${connId}`));
  }

  async setDomainContext(connId: string, text: string): Promise<void> {
    await this.memento.update(`${DOMAIN_CONTEXT_PREFIX}${connId}`, normalize(text) || undefined);
  }

  getDefaultDirectives(connId: string): string {
    return normalize(this.memento.get<string>(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`));
  }

  async setDefaultDirectives(connId: string, text: string): Promise<void> {
    await this.memento.update(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`, normalize(text) || undefined);
  }

  getLastScope(connId: string): AiScopeRef | undefined {
    const raw = this.memento.get<AiScopeRef>(`${LAST_SCOPE_PREFIX}${connId}`);
    if (raw && typeof raw.value === 'string' && raw.value) return raw;
    return undefined;
  }

  async setLastScope(connId: string, scope: AiScopeRef | undefined): Promise<void> {
    await this.memento.update(`${LAST_SCOPE_PREFIX}${connId}`, scope);
  }

  /** 连接 + 作用域级"上次勾选的表"（表选择抽屉；空数组 = 自动模式）。 */
  getSelectedTables(connId: string, scope: string): string[] {
    const raw = this.memento.get<string[]>(`${SELECTED_TABLES_PREFIX}${connId}.${scope}`);
    return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string' && name.length > 0) : [];
  }

  async setSelectedTables(connId: string, scope: string, tables: string[]): Promise<void> {
    await this.memento.update(`${SELECTED_TABLES_PREFIX}${connId}.${scope}`, tables.length > 0 ? tables : undefined);
  }

  /** 读取（连接 + 作用域）的表/列注记；脏数据经归一化（非法项丢弃、超限截断）。 */
  getSchemaNotes(connId: string, scope: string): SchemaNotes {
    const raw = this.memento.get<unknown>(`${SCHEMA_NOTES_PREFIX}${connId}.${scope}`);
    if (!raw || typeof raw !== 'object') return { tables: {} };
    const source = (raw as { tables?: unknown }).tables;
    if (!source || typeof source !== 'object') return { tables: {} };
    const tables: Record<string, TableNote> = {};
    for (const [table, entry] of Object.entries(source as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const note = clampNote((entry as { note?: unknown }).note, TABLE_NOTE_MAX_CHARS);
      const columns: Record<string, ColumnNote> = {};
      const rawColumns = (entry as { columns?: unknown }).columns;
      if (rawColumns && typeof rawColumns === 'object') {
        for (const [column, columnEntry] of Object.entries(rawColumns as Record<string, unknown>)) {
          if (!columnEntry || typeof columnEntry !== 'object') continue;
          const columnNote = clampNote((columnEntry as { note?: unknown }).note, COLUMN_NOTE_MAX_CHARS);
          const sample = clampNote((columnEntry as { sample?: unknown }).sample, SAMPLE_MAX_CHARS);
          if (columnNote || sample) columns[column] = { ...(columnNote ? { note: columnNote } : {}), ...(sample ? { sample } : {}) };
        }
      }
      const hasColumns = Object.keys(columns).length > 0;
      if (note || hasColumns) tables[table] = { ...(note ? { note } : {}), ...(hasColumns ? { columns } : {}) };
    }
    return { tables };
  }

  /**
   * 保存单表注记（编辑器整表覆盖式提交；空内容即删除该表条目）。
   * 超上限（单库 500 列条目）拒绝保存，返回 `{ ok:false }`（调用方提示用户精简）。
   */
  async saveTableNote(
    connId: string,
    scope: string,
    table: string,
    entry: { note?: string; columns: Array<{ name: string; note?: string; sample?: string }> },
  ): Promise<{ ok: true } | { ok: false; reason: 'limit' }> {
    const current = this.getSchemaNotes(connId, scope);
    const note = clampNote(entry.note, TABLE_NOTE_MAX_CHARS);
    const columns: Record<string, ColumnNote> = {};
    for (const column of entry.columns) {
      if (!column || typeof column.name !== 'string' || !column.name) continue;
      const columnNote = clampNote(column.note, COLUMN_NOTE_MAX_CHARS);
      const sample = clampNote(column.sample, SAMPLE_MAX_CHARS);
      if (columnNote || sample) columns[column.name] = { ...(columnNote ? { note: columnNote } : {}), ...(sample ? { sample } : {}) };
    }
    const hasColumns = Object.keys(columns).length > 0;
    if (note || hasColumns) current.tables[table] = { ...(note ? { note } : {}), ...(hasColumns ? { columns } : {}) };
    else delete current.tables[table];

    const totalColumns = Object.values(current.tables).reduce((sum, item) => sum + Object.keys(item.columns ?? {}).length, 0);
    if (totalColumns > MAX_COLUMN_ENTRIES) return { ok: false, reason: 'limit' };

    const hasAny = Object.keys(current.tables).length > 0;
    await this.memento.update(`${SCHEMA_NOTES_PREFIX}${connId}.${scope}`, hasAny ? current : undefined);
    return { ok: true };
  }

  /** 连接被删除时清理全部连接级键（含逐作用域的表选择与表/列注记），幂等。 */
  async clearForConnection(connId: string): Promise<void> {
    await this.memento.update(`${DOMAIN_CONTEXT_PREFIX}${connId}`, undefined);
    await this.memento.update(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`, undefined);
    await this.memento.update(`${LAST_SCOPE_PREFIX}${connId}`, undefined);
    for (const key of this.memento.keys()) {
      if (key.startsWith(`${SELECTED_TABLES_PREFIX}${connId}.`) || key.startsWith(`${SCHEMA_NOTES_PREFIX}${connId}.`)) {
        await this.memento.update(key, undefined);
      }
    }
  }
}