import type { MetadataService } from '@devbelt/db-core';
import type { DictionaryForeignKey, DictionaryModel, DictionaryTable } from './dataDictionary';

export const DICTIONARY_MAX_TABLES = 500;
export const DICTIONARY_CONCURRENCY = 4;

export interface CollectOptions {
  database?: string;
  schema?: string;
  dbType: string;
  maxTables?: number;
  concurrency?: number;
  /** Called after each table (for progress reporting). */
  onProgress?: (done: number, total: number) => void;
  /** Return true to stop early (cancellation). */
  isCancelled?: () => boolean;
  now?: () => Date;
}

export interface CollectResult {
  model: DictionaryModel;
  /** Tables whose metadata could not be read (permission / dropped meanwhile). */
  skipped: string[];
  cancelled: boolean;
}

type DictionaryMetadata = Pick<MetadataService, 'getTables' | 'getColumns' | 'getIndexes' | 'getForeignKeys'>;

/** Group per-column FK rows into constraints (same constraint/table/ref target). */
export function groupForeignKeys(rows: Awaited<ReturnType<MetadataService['getForeignKeys']>>): Map<string, DictionaryForeignKey[]> {
  const byTable = new Map<string, Map<string, DictionaryForeignKey>>();
  for (const row of rows) {
    const key = `${row.constraintName ?? ''}\u0000${row.refSchema ?? ''}\u0000${row.refTable}`;
    let table = byTable.get(row.tableName);
    if (!table) { table = new Map(); byTable.set(row.tableName, table); }
    const fk = table.get(key) ?? {
      ...(row.constraintName ? { name: row.constraintName } : {}),
      columns: [],
      refTable: row.refTable,
      ...(row.refSchema ? { refSchema: row.refSchema } : {}),
      refColumns: [],
    };
    fk.columns.push(row.columnName);
    fk.refColumns.push(row.refColumn);
    table.set(key, fk);
  }
  return new Map([...byTable].map(([t, m]) => [t, [...m.values()]]));
}

/**
 * Read the metadata needed for a data dictionary (P10 S8). Read-only.
 *
 * One call each for tables and foreign keys, then columns + indexes per table
 * with bounded concurrency. A table that fails is listed in `skipped` and the
 * rest still export; the table count is capped and flagged as truncated.
 */
export async function collectDictionary(metadata: DictionaryMetadata, options: CollectOptions): Promise<CollectResult> {
  const maxTables = options.maxTables ?? DICTIONARY_MAX_TABLES;
  const concurrency = Math.max(1, options.concurrency ?? DICTIONARY_CONCURRENCY);
  const [allTables, fkRows] = await Promise.all([
    metadata.getTables(options.database, options.schema),
    metadata.getForeignKeys(options.database, options.schema).catch(() => []),
  ]);
  const sorted = [...allTables].sort((a, b) => a.name.localeCompare(b.name));
  const selected = sorted.slice(0, maxTables);
  const fks = groupForeignKeys(fkRows);

  const results: Array<DictionaryTable | undefined> = new Array(selected.length);
  const skipped: string[] = [];
  let next = 0;
  let done = 0;
  let cancelled = false;

  const worker = async (): Promise<void> => {
    while (next < selected.length) {
      if (options.isCancelled?.()) { cancelled = true; return; }
      const index = next++;
      const meta = selected[index];
      try {
        const [columns, indexes] = await Promise.all([
          metadata.getColumns(meta.name, options.database, options.schema),
          metadata.getIndexes(meta.name, options.database, options.schema).catch(() => []),
        ]);
        results[index] = {
          name: meta.name,
          comment: meta.comment ?? '',
          ...(meta.table_rows !== undefined && meta.table_rows !== null && meta.table_rows !== '' ? { rowsEstimate: String(meta.table_rows) } : {}),
          columns: columns.map((c) => ({
            name: c.name,
            type: c.type || c.simpleType || '',
            nullable: !c.isNotNull,
            defaultValue: c.defaultValue === undefined || c.defaultValue === null ? '' : String(c.defaultValue),
            comment: c.comment ?? '',
            isPrimary: !!c.isPrimary,
            isAutoIncrement: !!c.isAutoIncrement,
          })),
          indexes: indexes.map((i) => ({
            name: i.name,
            columns: i.columns,
            isUnique: !!i.isUnique,
            isPrimary: !!i.isPrimary,
          })),
          foreignKeys: fks.get(meta.name) ?? [],
        };
      } catch {
        skipped.push(meta.name);
      } finally {
        done++;
        options.onProgress?.(done, selected.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length || 1) }, worker));

  return {
    model: {
      ...(options.database ? { database: options.database } : {}),
      ...(options.schema ? { schema: options.schema } : {}),
      dbType: options.dbType,
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      tables: results.filter((t): t is DictionaryTable => !!t),
      totalTables: allTables.length,
      truncated: allTables.length > selected.length,
    },
    skipped: skipped.sort(),
    cancelled,
  };
}