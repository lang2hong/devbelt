import type { BuiltinRule, MaskingRule } from './mask.js';

export interface TableMaskingConfig {
  /** Raw WHERE clause (workspace-authored, not model-generated). */
  where?: string;
  columns?: Record<string, MaskingRule>;
  /** Columns allowed to leave unmasked even when the name looks like PII. */
  allowUnmasked?: string[];
}

export interface MaskingConfig {
  version: 1;
  tables: Record<string, TableMaskingConfig>;
}

export type ConfigResult = { ok: true; config: MaskingConfig } | { ok: false; errors: string[] };

const RULES: readonly BuiltinRule[] = [
  'email', 'phone', 'name', 'address', 'idCard', 'bankCard', 'redact', 'null', 'hash', 'fixed', 'regex',
];
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function parseMaskingConfig(raw: unknown): ConfigResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['config must be an object'] };
  const body = raw as Record<string, unknown>;
  if (body.version !== 1) errors.push('version must be 1');
  const tablesRaw = body.tables;
  if (!tablesRaw || typeof tablesRaw !== 'object' || Array.isArray(tablesRaw)) {
    return { ok: false, errors: [...errors, 'tables must be an object'] };
  }
  const tables: Record<string, TableMaskingConfig> = {};
  for (const [table, value] of Object.entries(tablesRaw as Record<string, unknown>)) {
    if (!IDENT_RE.test(table)) { errors.push(`invalid table name: ${table}`); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${table}: must be an object`); continue; }
    const entry = value as Record<string, unknown>;
    const out: TableMaskingConfig = {};
    if (entry.where !== undefined) {
      if (typeof entry.where !== 'string' || entry.where.trim() === '') errors.push(`${table}.where must be a non-empty string`);
      else out.where = entry.where;
    }
    if (entry.allowUnmasked !== undefined) {
      if (!Array.isArray(entry.allowUnmasked) || !entry.allowUnmasked.every((c) => typeof c === 'string')) {
        errors.push(`${table}.allowUnmasked must be a string array`);
      } else out.allowUnmasked = entry.allowUnmasked as string[];
    }
    if (entry.columns !== undefined) {
      if (!entry.columns || typeof entry.columns !== 'object' || Array.isArray(entry.columns)) {
        errors.push(`${table}.columns must be an object`);
      } else {
        const columns: Record<string, MaskingRule> = {};
        for (const [column, ruleRaw] of Object.entries(entry.columns as Record<string, unknown>)) {
          if (!IDENT_RE.test(column)) { errors.push(`${table}.${column}: invalid column name`); continue; }
          const rule = parseRule(ruleRaw, `${table}.${column}`, errors);
          if (rule) columns[column] = rule;
        }
        out.columns = columns;
      }
    }
    tables[table] = out;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: { version: 1, tables } };
}

function parseRule(raw: unknown, where: string, errors: string[]): MaskingRule | undefined {
  if (typeof raw === 'string') raw = { rule: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${where}: rule must be a string or object`); return undefined; }
  const r = raw as Record<string, unknown>;
  const name = r.rule;
  if (typeof name !== 'string' || !RULES.includes(name as BuiltinRule)) {
    errors.push(`${where}: unknown rule ${String(name)}`);
    return undefined;
  }
  const rule: MaskingRule = { rule: name as BuiltinRule };
  if (name === 'fixed') {
    if (typeof r.value !== 'string') { errors.push(`${where}: fixed requires value`); return undefined; }
    rule.value = r.value;
  }
  if (name === 'regex') {
    if (typeof r.pattern !== 'string' || typeof r.replacement !== 'string') {
      errors.push(`${where}: regex requires pattern and replacement`);
      return undefined;
    }
    try { new RegExp(r.pattern); } catch { errors.push(`${where}: invalid regex`); return undefined; }
    rule.pattern = r.pattern;
    rule.replacement = r.replacement;
  }
  return rule;
}