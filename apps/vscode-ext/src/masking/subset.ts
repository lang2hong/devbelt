import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ColumnMeta, ForeignKeyMeta, QueryService } from '@devbelt/db-core';
import { qualifyTable } from '@devbelt/db-core';
import { isPiiColumn, maskValue, type MaskingConfig, type TableMaskingConfig } from '@devbelt/masking-core';
import { exportRows } from '../data/transfer/exportService.js';
import { MaskingExportError } from './export.js';

export interface SubsetExportDeps {
  query: Pick<QueryService, 'query'>;
  dialect: QueryService['dialect'];
  metadata: {
    getColumns(table: string, database?: string, schema?: string): Promise<ColumnMeta[]>;
    getForeignKeys(database?: string, schema?: string): Promise<ForeignKeyMeta[]>;
  };
  database?: string;
  schema?: string;
  config: MaskingConfig;
  salt: string;
  rootTable: string;
  maxRowsTotal?: number;
}

export interface SubsetTable {
  name: string;
  columns: ColumnMeta[];
  rows: Array<Record<string, unknown>>;
}

export interface SubsetResult {
  tables: SubsetTable[];
  rows: number;
}

const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_DEPTH = 2;

export class SubsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubsetError';
  }
}

export async function collectMaskedSubset(deps: SubsetExportDeps): Promise<SubsetResult> {
  const allFks = await deps.metadata.getForeignKeys(deps.database, deps.schema);
  const fks = singleColumnFks(allFks);
  const outgoing = new Map<string, ForeignKeyMeta[]>();
  const incoming = new Map<string, ForeignKeyMeta[]>();
  for (const fk of fks) {
    push(outgoing, fk.tableName, fk);
    push(incoming, fk.refTable, fk);
  }

  const budget = deps.maxRowsTotal ?? deps.config.maxRowsTotal ?? DEFAULT_MAX_ROWS;
  const rootEntry = deps.config.tables[deps.rootTable] ?? {};
  const maxDepth = rootEntry.maxDepth ?? DEFAULT_DEPTH;

  const collected = new Map<string, { columns: ColumnMeta[]; rows: Map<string, Record<string, unknown>>; pk: string }>();
  const queue: Array<{ table: string; depth: number }> = [{ table: deps.rootTable, depth: 0 }];
  const rootBucket = await tableBucket(deps, deps.rootTable, collected);
  let total = rootBucket.rows.size;

  while (queue.length > 0) {
    const node = queue.shift()!;
    const bucket = await tableBucket(deps, node.table, collected);
    if (bucket.rows.size === 0 && node.table === deps.rootTable) {
      // Root may legitimately match zero rows; nothing to expand.
      continue;
    }
    if (node.depth >= maxDepth) continue;

    if (rootEntry.referenced === true) {
      for (const fk of outgoing.get(node.table) ?? []) {
        const values = distinct(bucket.rows, fk.columnName);
        if (values.length === 0) continue;
        const parent = await tableBucket(deps, fk.refTable, collected);
        const fetched = await fetchRows(deps, fk.refTable, parent.pk, values, budget - total);
        for (const row of fetched) {
          const key = String(row[parent.pk]);
          if (parent.rows.has(key)) continue;
          parent.rows.set(key, row);
          total += 1;
          if (total > budget) throw new SubsetError(`Row budget exceeded (${budget}); narrow the WHERE clause or raise maxRowsTotal.`);
          queue.push({ table: fk.refTable, depth: node.depth + 1 });
        }
      }
    }
    if (rootEntry.referencing === true) {
      for (const fk of incoming.get(node.table) ?? []) {
        const values = distinct(bucket.rows, bucket.pk);
        if (values.length === 0) continue;
        const child = await tableBucket(deps, fk.tableName, collected);
        const fetched = await fetchRows(deps, fk.tableName, fk.columnName, values, budget - total);
        for (const row of fetched) {
          const key = String(row[child.pk]);
          if (child.rows.has(key)) continue;
          child.rows.set(key, row);
          total += 1;
          if (total > budget) throw new SubsetError(`Row budget exceeded (${budget}); narrow the WHERE clause or raise maxRowsTotal.`);
          queue.push({ table: fk.tableName, depth: node.depth + 1 });
        }
      }
    }
  }

  const tables = [...collected.entries()].map(([name, b]) => ({ name, columns: b.columns, rows: [...b.rows.values()] }));
  const ordered = orderByDependencies(tables, fks);
  maskTables(deps, ordered, fks);
  return { tables: ordered, rows: total };
}

export async function exportMaskedSubset(deps: SubsetExportDeps, file: string): Promise<SubsetResult & { file: string }> {
  const result = await collectMaskedSubset(deps);
  await writeSubsetSql(deps, result, file);
  return { ...result, file };
}

/** Write an already-collected subset as one SQL file (atomic, 0600). */
export async function writeSubsetSql(deps: SubsetExportDeps, result: SubsetResult, file: string): Promise<void> {
  const { tables } = result;
  const parts = tables.map((t) => {
    const columns = t.columns.map((c) => c.name);
    const sql = exportRows({
      format: 'sql',
      columns,
      rows: t.rows,
      table: t.name,
      ...(deps.database ? { database: deps.database } : {}),
      ...(deps.schema ? { schema: deps.schema } : {}),
      dialect: deps.dialect,
    });
    return `-- ${t.name}\n${String(sql)}`;
  });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(tmp, parts.join('\n\n') + '\n', { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function tableBucket(
  deps: SubsetExportDeps,
  table: string,
  collected: Map<string, { columns: ColumnMeta[]; rows: Map<string, Record<string, unknown>>; pk: string }>,
) {
  const existing = collected.get(table);
  if (existing) return existing;
  const columns = await deps.metadata.getColumns(table, deps.database, deps.schema);
  if (columns.length === 0) throw new SubsetError(`Table not found: ${table}`);
  const pks = columns.filter((c) => c.isPrimary);
  if (pks.length !== 1) throw new SubsetError(`Table ${table} needs a single-column primary key for subset export`);
  const bucket = { columns, rows: new Map<string, Record<string, unknown>>(), pk: pks[0]!.name };
  collected.set(table, bucket);
  if (table === deps.rootTable) {
    const entry = deps.config.tables[table] ?? {};
    const fetched = await fetchRoot(deps, table, entry, deps.maxRowsTotal ?? deps.config.maxRowsTotal ?? DEFAULT_MAX_ROWS);
    for (const row of fetched) bucket.rows.set(String(row[bucket.pk]), row);
  }
  return bucket;
}

async function fetchRoot(deps: SubsetExportDeps, table: string, entry: TableMaskingConfig, limit: number): Promise<Array<Record<string, unknown>>> {
  const sql = `SELECT * FROM ${qualified(deps, table)}${entry.where ? ` WHERE ${entry.where}` : ''} LIMIT ${limit + 1}`;
  const res = await deps.query.query(sql, undefined, { skipHistory: true });
  const rows = Array.isArray(res.rows) ? (res.rows as Array<Record<string, unknown>>) : [];
  if (rows.length > limit) throw new SubsetError(`Root query matched more than ${limit} rows; narrow the WHERE clause.`);
  return rows;
}

async function fetchRows(
  deps: SubsetExportDeps,
  table: string,
  column: string,
  values: unknown[],
  remaining: number,
): Promise<Array<Record<string, unknown>>> {
  if (values.length === 0 || remaining <= 0) return [];
  const literals = values.map((v) => deps.dialect.escapeValue(v)).join(', ');
  const sql = `SELECT * FROM ${qualified(deps, table)} WHERE ${deps.dialect.wrap(column)} IN (${literals}) LIMIT ${remaining + 1}`;
  const res = await deps.query.query(sql, undefined, { skipHistory: true });
  const rows = Array.isArray(res.rows) ? (res.rows as Array<Record<string, unknown>>) : [];
  if (rows.length > remaining) throw new SubsetError(`Row budget exceeded while reading ${table}`);
  return rows;
}

function maskTables(deps: SubsetExportDeps, tables: SubsetTable[], fks: ForeignKeyMeta[]): void {
  const fkDomain = new Map<string, string>();
  const included = new Set(tables.map((t) => t.name));
  const effective = new Map<string, Record<string, import('@devbelt/masking-core').MaskingRule>>();
  for (const table of tables) effective.set(table.name, { ...(deps.config.tables[table.name]?.columns ?? {}) });
  for (const fk of fks) {
    fkDomain.set(`${fk.tableName}.${fk.columnName}`, `${fk.refTable}.${fk.refColumn}`);
    if (!included.has(fk.tableName) || !included.has(fk.refTable)) continue;
    const parentRule = deps.config.tables[fk.refTable]?.columns?.[fk.refColumn];
    const childRules = effective.get(fk.tableName)!;
    if (parentRule && !childRules[fk.columnName]) {
      // Both sides must be masked with the same rule; inherit from the parent key.
      childRules[fk.columnName] = parentRule;
    } else if (!parentRule && childRules[fk.columnName]) {
      throw new MaskingExportError(
        `Foreign key ${fk.tableName}.${fk.columnName} is masked but the referenced key ${fk.refTable}.${fk.refColumn} is not; add a rule for the referenced key`,
      );
    }
  }
  for (const table of tables) {
    const entry = deps.config.tables[table.name] ?? {};
    const rules = effective.get(table.name)!;
    const allow = new Set(entry.allowUnmasked ?? []);
    const missing = table.columns.filter((c) => isPiiColumn(c.name) && !rules[c.name] && !allow.has(c.name)).map((c) => c.name);
    if (missing.length > 0) throw new MaskingExportError(`PII columns need a masking rule or allowUnmasked entry (${table.name}): ${missing.join(', ')}`);
    for (const [column, rule] of Object.entries(rules)) {
      const meta = table.columns.find((c) => c.name === column);
      if (!meta) throw new MaskingExportError(`Unknown column in masking config: ${table.name}.${column}`);
      if (rule.rule === 'null' && meta.isNotNull) throw new MaskingExportError(`Column ${table.name}.${column} is NOT NULL and cannot use the null rule`);
    }
    for (const row of table.rows) {
      for (const [column, rule] of Object.entries(rules)) {
        const meta = table.columns.find((c) => c.name === column)!;
        const maxLength = Number(meta.maxLength);
        row[column] = maskValue(rule, row[column], {
          salt: deps.salt,
          domain: fkDomain.get(`${table.name}.${column}`) ?? `${table.name}.${column}`,
          ...(Number.isFinite(maxLength) && maxLength > 0 ? { maxLength } : {}),
        });
      }
    }
    const pk = table.columns.find((c) => c.isPrimary)!;
    const seen = new Set<string>();
    for (const row of table.rows) {
      const key = String(row[pk.name]);
      if (seen.has(key)) throw new MaskingExportError(`Masking produced a duplicate primary key for ${table.name}`);
      seen.add(key);
    }
  }
}

function orderByDependencies(tables: SubsetTable[], fks: ForeignKeyMeta[]): SubsetTable[] {
  const names = new Set(tables.map((t) => t.name));
  const indegree = new Map<string, number>([...names].map((n) => [n, 0]));
  const edges = new Map<string, Set<string>>();
  for (const fk of fks) {
    if (!names.has(fk.tableName) || !names.has(fk.refTable) || fk.tableName === fk.refTable) continue;
    const set = edges.get(fk.refTable) ?? new Set<string>();
    if (!set.has(fk.tableName)) { set.add(fk.tableName); indegree.set(fk.tableName, (indegree.get(fk.tableName) ?? 0) + 1); }
    edges.set(fk.refTable, set);
  }
  const queue = [...names].filter((n) => (indegree.get(n) ?? 0) === 0).sort();
  const out: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    out.push(name);
    for (const next of edges.get(name) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (out.length !== names.size) throw new SubsetError('Cyclic foreign keys prevent a deterministic export order');
  return out.map((n) => tables.find((t) => t.name === n)!);
}

function singleColumnFks(fks: ForeignKeyMeta[]): ForeignKeyMeta[] {
  const groups = new Map<string, ForeignKeyMeta[]>();
  for (const fk of fks) {
    const key = fk.constraintName ?? `${fk.tableName}.${fk.columnName}`;
    groups.set(key, [...(groups.get(key) ?? []), fk]);
  }
  for (const [key, group] of groups) {
    if (group.length > 1) throw new SubsetError(`Composite foreign keys are not supported (${key})`);
  }
  return fks;
}

function distinct(rows: Map<string, Record<string, unknown>>, column: string): unknown[] {
  const out = new Map<string, unknown>();
  for (const row of rows.values()) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    out.set(String(value), value);
  }
  return [...out.values()];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function qualified(deps: SubsetExportDeps, table: string): string {
  return qualifyTable(
    deps.dialect.dbType,
    deps.dialect.wrap(table),
    deps.database ? deps.dialect.wrap(deps.database) : undefined,
    deps.schema ? deps.dialect.wrap(deps.schema) : undefined,
  );
}