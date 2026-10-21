import type * as vscode from 'vscode';
import { uniqueId } from '@devbelt/db-host/utils/id';
import type { SyncBusinessRules } from '@devbelt/db-host/sync/e2e/schemaNotesTypes';

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
/**
 * S7f：表/列注记的**记录式**存储前缀（record-keyed，键与 E2EE 同步实体 localId 同源）。
 * 旧版按 `<connId>.<库>` 键控（SCHEMA_NOTES_PREFIX 直连）仍可读，保存时自动迁移。
 */
export const SCHEMA_NOTES_RECORD_PREFIX = 'devbelt.ai.schemaNotes.rec.';
/** 业务规则复用 schemaNotes 实体时的保留 scope（不会与真实库/索引名冲突）。 */
export const BUSINESS_RULES_SCOPE = '__ai_business_rules__';

/** 表/列临时说明与样例（S7e）。 */
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

/** S7f：一条注记记录（= 一个同步实体；connId 为本地 localId，同步层换算 recordId）。 */
export interface SchemaNotesRecord {
  id: string;
  connId: string;
  scope: string;
  tables: Record<string, TableNote>;
  /** 保留 scope 记录上的连接级业务规则（复用 schemaNotes 同步实体）。 */
  businessRules?: SyncBusinessRules;
  updateTime: number;
  deleted?: boolean;
}

/** 归一化 tables（非法项丢弃、超限截断）；旧格式/远端 payload 共用。 */
export function normalizeTables(source: unknown): Record<string, TableNote> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
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
  return tables;
}

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

function normalizeBusinessRules(raw: unknown): SyncBusinessRules | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.domainContext !== 'string' || typeof o.defaultDirectives !== 'string') return undefined;
  const domainContext = normalize(o.domainContext);
  const defaultDirectives = normalize(o.defaultDirectives);
  return domainContext || defaultDirectives ? { domainContext, defaultDirectives } : undefined;
}

export class AiContextStore {
  constructor(private readonly memento: vscode.Memento) {}

  getDomainContext(connId: string): string {
    return this.getBusinessRules(connId).domainContext;
  }

  async setDomainContext(connId: string, text: string): Promise<void> {
    const current = this.getBusinessRules(connId);
    await this.setBusinessRules(connId, { ...current, domainContext: text });
  }

  getDefaultDirectives(connId: string): string {
    return this.getBusinessRules(connId).defaultDirectives;
  }

  async setDefaultDirectives(connId: string, text: string): Promise<void> {
    const current = this.getBusinessRules(connId);
    await this.setBusinessRules(connId, { ...current, defaultDirectives: text });
  }

  /** 连接级业务规则：记录式优先，旧 Memento 键懒迁移读取。 */
  getBusinessRules(connId: string): SyncBusinessRules {
    const record = this.findSchemaNoteRecord(connId, BUSINESS_RULES_SCOPE);
    if (record?.businessRules) return record.businessRules;
    return {
      domainContext: normalize(this.memento.get<string>(`${DOMAIN_CONTEXT_PREFIX}${connId}`)),
      defaultDirectives: normalize(this.memento.get<string>(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`)),
    };
  }

  /** 一次写入两段业务规则（空则墓碑），并清理旧键。 */
  async setBusinessRules(connId: string, rules: SyncBusinessRules): Promise<void> {
    const normalized = normalizeBusinessRules(rules);
    const existing = this.findSchemaNoteRecord(connId, BUSINESS_RULES_SCOPE);
    if (normalized) {
      await this.writeSchemaNoteRecord({
        id: existing?.id ?? uniqueId('sn'),
        connId,
        scope: BUSINESS_RULES_SCOPE,
        tables: existing?.tables ?? {},
        businessRules: normalized,
      });
    } else if (existing) {
      await this.removeSchemaNoteRecord(existing.id);
    }
    await this.memento.update(`${DOMAIN_CONTEXT_PREFIX}${connId}`, undefined);
    await this.memento.update(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`, undefined);
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

  /** 读取（连接 + 作用域）的表/列注记；记录式优先，旧格式兜底。 */
  getSchemaNotes(connId: string, scope: string): SchemaNotes {
    const record = this.findSchemaNoteRecord(connId, scope);
    if (record) return { tables: record.tables };
    const raw = this.memento.get<unknown>(`${SCHEMA_NOTES_PREFIX}${connId}.${scope}`);
    const source = raw && typeof raw === 'object' ? (raw as { tables?: unknown }).tables : undefined;
    return { tables: normalizeTables(source) };
  }

  /**
   * 保存单表注记（编辑器整表覆盖式提交；空内容即删除该表条目）。
   * 超上限（单库 500 列条目）拒绝保存；清空全部 → 记录墓碑（跨设备传播删除）。
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

    const existing = this.findSchemaNoteRecord(connId, scope);
    const legacyKey = `${SCHEMA_NOTES_PREFIX}${connId}.${scope}`;
    const hasAny = Object.keys(current.tables).length > 0;
    if (hasAny) {
      await this.writeSchemaNoteRecord({ id: existing?.id ?? uniqueId('sn'), connId, scope, tables: current.tables });
    } else if (existing) {
      await this.removeSchemaNoteRecord(existing.id);
    }
    await this.memento.update(legacyKey, undefined);
    return { ok: true };
  }

  // ── S7f：同步实体面（供 SchemaNotesSyncBackend 消费；含墓碑） ──

  /** 全部注记记录（含墓碑）；记录数少，按 memento 键前缀扫描即可。 */
  listSchemaNoteRecords(): SchemaNotesRecord[] {
    const out: SchemaNotesRecord[] = [];
    for (const key of this.memento.keys()) {
      if (!key.startsWith(SCHEMA_NOTES_RECORD_PREFIX)) continue;
      const record = this.parseSchemaNoteRecord(key.slice(SCHEMA_NOTES_RECORD_PREFIX.length), this.memento.get<unknown>(key));
      if (record) out.push(record);
    }
    return out;
  }

  getSchemaNoteRecord(id: string): SchemaNotesRecord | undefined {
    if (!id) return undefined;
    return this.parseSchemaNoteRecord(id, this.memento.get<unknown>(`${SCHEMA_NOTES_RECORD_PREFIX}${id}`));
  }

  /** 写入记录（同步应用/本地保存共用；updateTime 由存储层打点）。 */
  async saveSchemaNoteRecord(id: string, value: { connId: string; scope: string; tables: Record<string, unknown>; businessRules?: SyncBusinessRules }): Promise<void> {
    await this.writeSchemaNoteRecord({
      id,
      connId: value.connId,
      scope: value.scope,
      tables: normalizeTables(value.tables),
      ...(value.businessRules ? { businessRules: value.businessRules } : {}),
    });
  }

  /** 墓碑（跨设备删除传播；保留 connId/scope 供同步识别）。 */
  async removeSchemaNoteRecord(id: string): Promise<void> {
    const existing = this.getSchemaNoteRecord(id);
    if (!existing) return;
    await this.writeSchemaNoteRecord({ ...existing, deleted: true });
  }

  private findSchemaNoteRecord(connId: string, scope: string): SchemaNotesRecord | undefined {
    return this.listSchemaNoteRecords().find((record) => !record.deleted && record.connId === connId && record.scope === scope);
  }

  private parseSchemaNoteRecord(id: string, raw: unknown): SchemaNotesRecord | undefined {
    if (!id || !raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    if (typeof o.connId !== 'string' || typeof o.scope !== 'string') return undefined;
    return {
      id,
      connId: o.connId,
      scope: o.scope,
      tables: normalizeTables(o.tables),
      ...(o.businessRules !== undefined ? { ...(normalizeBusinessRules(o.businessRules) ? { businessRules: normalizeBusinessRules(o.businessRules) } : {}) } : {}),
      updateTime: typeof o.updateTime === 'number' && Number.isFinite(o.updateTime) ? o.updateTime : 0,
      ...(o.deleted === true ? { deleted: true } : {}),
    };
  }

  private async writeSchemaNoteRecord(record: Omit<SchemaNotesRecord, 'updateTime'>): Promise<void> {
    await this.memento.update(`${SCHEMA_NOTES_RECORD_PREFIX}${record.id}`, {
      connId: record.connId,
      scope: record.scope,
      tables: record.tables,
      ...(record.businessRules ? { businessRules: record.businessRules } : {}),
      updateTime: Date.now(),
      ...(record.deleted ? { deleted: true } : {}),
    });
  }

  /** 连接被删除时清理：连接级键删除，注记记录走墓碑（删除随同步传播），幂等。 */
  async clearForConnection(connId: string): Promise<void> {
    await this.memento.update(`${DOMAIN_CONTEXT_PREFIX}${connId}`, undefined);
    await this.memento.update(`${DEFAULT_DIRECTIVES_PREFIX}${connId}`, undefined);
    await this.memento.update(`${LAST_SCOPE_PREFIX}${connId}`, undefined);
    for (const record of this.listSchemaNoteRecords()) {
      if (record.connId === connId && !record.deleted) await this.removeSchemaNoteRecord(record.id);
    }
    for (const key of this.memento.keys()) {
      if (key.startsWith(`${SELECTED_TABLES_PREFIX}${connId}.`) || key.startsWith(`${SCHEMA_NOTES_PREFIX}${connId}.`)) {
        await this.memento.update(key, undefined);
      }
    }
  }
}