import { estimateTokens } from './usage.js';
import { isSensitiveColumnName } from './sensitive.js';

export interface AiSchemaColumn {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
  primaryKey?: boolean;
  unique?: boolean;
  /** 外键目标，形如 `users.id`。 */
  references?: string;
}

export interface AiSchemaIndex {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface AiSchemaTable {
  name: string;
  columns: AiSchemaColumn[];
  indexes?: AiSchemaIndex[];
}

export interface AiSchemaInput {
  dbType: string;
  database?: string;
  /** PG 等含 schema 维度的引擎使用。 */
  schema?: string;
  /** 由调用方按优先级（最近使用/显式引用）排序；超限时取前 N 张。 */
  tables: AiSchemaTable[];
}

export interface SerializeSchemaOptions {
  /** 表数量上限，默认 200。 */
  maxTables?: number;
  /** 每表列数上限，默认 50。 */
  maxColumnsPerTable?: number;
  /** 敏感列判定覆盖（默认内置黑名单）。 */
  isSensitive?: (name: string) => boolean;
}

export interface SerializedSchema {
  text: string;
  tableCount: number;
  totalTables: number;
  truncated: boolean;
  estimatedTokens: number;
}

const DEFAULT_MAX_TABLES = 200;
const DEFAULT_MAX_COLUMNS_PER_TABLE = 50;

/**
 * 把数据库 schema 序列化成紧凑 prompt 文本。
 *
 * 只包含表名、列名/类型/约束/NOT NULL/默认值/索引/外键元数据：
 *  - 不含行样本（数据问答场景由 `formatRowSample` 单独处理）；
 *  - 不含列注释/存储过程（v1 有意不做，减少 prompt 注入面）；
 *  - 敏感列的列名/类型仍然输出（否则 AI 无法生成正确 SQL），命中时打 `[SENSITIVE]` 标记。
 */
export function serializeSchema(input: AiSchemaInput, options: SerializeSchemaOptions = {}): SerializedSchema {
  const maxTables = options.maxTables ?? DEFAULT_MAX_TABLES;
  const maxColumns = options.maxColumnsPerTable ?? DEFAULT_MAX_COLUMNS_PER_TABLE;
  const isSensitive = options.isSensitive ?? isSensitiveColumnName;

  const totalTables = input.tables.length;
  const tables = input.tables.slice(0, Math.max(maxTables, 0));
  const truncated = totalTables > tables.length;

  const header: string[] = [`# Database: ${input.dbType}`];
  if (input.database) header.push(`database: ${input.database}`);
  if (input.schema) header.push(`schema: ${input.schema}`);
  const lines: string[] = [header.join(', ')];
  if (truncated) {
    lines.push(`# NOTE: schema truncated to ${tables.length} of ${totalTables} tables (by caller priority order)`);
  }

  for (const table of tables) {
    lines.push(`## Table: ${table.name}`);
    const columns = table.columns.slice(0, Math.max(maxColumns, 0));
    for (const column of columns) lines.push(formatColumn(column, isSensitive));
    const omitted = table.columns.length - columns.length;
    if (omitted > 0) lines.push(`- ... ${omitted} more columns omitted`);
    for (const index of table.indexes ?? []) {
      lines.push(`- ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} (${index.columns.join(', ')})`);
    }
  }

  const text = lines.join('\n');
  return {
    text,
    tableCount: tables.length,
    totalTables,
    truncated,
    estimatedTokens: estimateTokens(text),
  };
}

function formatColumn(column: AiSchemaColumn, isSensitive: (name: string) => boolean): string {
  let line = `- ${column.name} ${column.type}`;
  if (column.nullable === false) line += ' NOT NULL';
  if (column.primaryKey) line += ' PRIMARY KEY';
  else if (column.unique) line += ' UNIQUE';
  if (column.defaultValue !== undefined) line += ` DEFAULT ${column.defaultValue}`;
  if (column.references) line += ` FOREIGN KEY -> ${column.references}`;
  if (isSensitive(column.name)) line += ' [SENSITIVE]';
  return line;
}