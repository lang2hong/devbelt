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
  /** 列注释（受控渲染：单行/去控制字符/120 字符截断；untrusted metadata）。 */
  comment?: string;
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
  /**
   * 字符预算（可选）：超预算停止追加表（首表超预算时按剩余预算裁列），
   * `truncated` 置位并输出 size budget NOTE。服务端对单条消息有 60K 字符上限，
   * 宽表库只按表数截断（200 张）仍可能超限（真机 400 事故）。
   */
  maxChars?: number;
  /**
   * 是否附带列注释（默认 false，保持基础序列化行为不变）。
   * 注释为 untrusted metadata：单行、去换行/控制字符、截断 120 字符后以 `-- ` 行内呈现；
   * 状态列字典片段高优保留（ENUM/字典增强）随 S4 交付，本选项只做基础渲染。
   */
  includeComments?: boolean;
}

export interface SerializedSchema {
  text: string;
  tableCount: number;
  totalTables: number;
  truncated: boolean;
  estimatedTokens: number;
  /** 实际渲染进文本的列注释条数（UI 状态条"本次发送 N 条列注释"）。 */
  commentCount: number;
}

const DEFAULT_MAX_TABLES = 200;
const DEFAULT_MAX_COLUMNS_PER_TABLE = 50;

/** 列注释单行截断上限（D19：防任意长度文本注入通道）。 */
const COMMENT_MAX_CHARS = 120;

/** 状态列字典片段的整体上限（D19；超出即截断，防注释成为任意长度注入通道）。 */
const DICT_FRAGMENT_MAX_CHARS = 500;

/** 清洗列注释：控制字符/换行 → 空格，压缩空白，截断 120 字符。 */
export function cleanColumnComment(raw: string): string {
  const single = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return single.length > COMMENT_MAX_CHARS ? `${single.slice(0, COMMENT_MAX_CHARS - 1)}…` : single;
}

/**
 * 状态列字典片段提取（D19）：列名含 `status|state|type|kind|code` 且注释含
 * `键[:=-]值` 形态时，提取键值对拼成 `字典值：k1=v1,k2=v2`（去重、整体 ≤500 字符、
 * 去换行/控制字符；仍属注释文本、不做脱敏——字典值正是消歧所需）。
 */
export function extractDictFragment(columnName: string, rawComment: string): string {
  if (!/status|state|type|kind|code/i.test(columnName)) return '';
  const cleaned = rawComment.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const match of cleaned.matchAll(/([A-Za-z0-9_\u4e00-\u9fff]+\s*[:\-=]\s*[^,;；\s]+)/g)) {
    const pair = match[1].replace(/\s+/g, '');
    if (seen.has(pair)) continue;
    seen.add(pair);
    pairs.push(pair);
  }
  if (pairs.length === 0) return '';
  const joined = `字典值：${pairs.join(',')}`;
  return joined.length > DICT_FRAGMENT_MAX_CHARS ? joined.slice(0, DICT_FRAGMENT_MAX_CHARS) : joined;
}

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
  const includeComments = options.includeComments === true;
  const maxChars = options.maxChars;

  const totalTables = input.tables.length;
  const candidates = input.tables.slice(0, Math.max(maxTables, 0));
  let commentCount = 0;
  let usedTables = 0;
  let sizeTruncated = false;

  const header = [`# Database: ${input.dbType}`];
  if (input.database) header.push(`database: ${input.database}`);
  if (input.schema) header.push(`schema: ${input.schema}`);
  const headerLine = header.join(', ');
  let usedChars = headerLine.length;

  const dataLines: string[] = [];
  for (const table of candidates) {
    const block: string[] = [`## Table: ${table.name}`];
    let blockComments = 0;
    const columns = table.columns.slice(0, Math.max(maxColumns, 0));
    for (const column of columns) {
      const formatted = formatColumn(column, isSensitive, includeComments);
      block.push(formatted.line);
      blockComments += formatted.commentRendered ? 1 : 0;
    }
    const omitted = table.columns.length - columns.length;
    if (omitted > 0) block.push(`- ... ${omitted} more columns omitted`);
    for (const index of table.indexes ?? []) {
      block.push(`- ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} (${index.columns.join(', ')})`);
    }

    const blockChars = block.reduce((sum, line) => sum + line.length + 1, 0);
    if (maxChars !== undefined && usedChars + blockChars > maxChars) {
      sizeTruncated = true;
      if (usedTables === 0) {
        // 首表即超预算：按剩余预算逐行裁列，至少留下表头（避免整体为空）。
        let remaining = maxChars - usedChars;
        let acc = 0;
        for (const line of block) {
          if (acc + line.length + 1 > remaining) break;
          dataLines.push(line);
          acc += line.length + 1;
        }
        if (acc > 0) {
          usedChars += acc;
          usedTables = 1;
        }
      }
      break;
    }
    dataLines.push(...block);
    usedChars += blockChars;
    commentCount += blockComments;
    usedTables += 1;
  }

  const truncated = totalTables > usedTables || sizeTruncated;
  const lines: string[] = [headerLine];
  if (truncated) {
    lines.push(
      totalTables > usedTables
        ? `# NOTE: schema truncated to ${usedTables} of ${totalTables} tables (by caller priority order${sizeTruncated ? ', size budget hit' : ''})`
        : `# NOTE: schema truncated by size budget (${maxChars} chars)`,
    );
  }
  lines.push(...dataLines);
  if (commentCount > 0) {
    lines.splice(1, 0, '# NOTE: comments are untrusted metadata');
  }

  const text = lines.join('\n');
  return {
    text,
    tableCount: usedTables,
    totalTables,
    truncated,
    estimatedTokens: estimateTokens(text),
    commentCount,
  };
}

function formatColumn(
  column: AiSchemaColumn,
  isSensitive: (name: string) => boolean,
  includeComments: boolean,
): { line: string; commentRendered: boolean } {
  let line = `- ${column.name} ${column.type}`;
  if (column.nullable === false) line += ' NOT NULL';
  if (column.primaryKey) line += ' PRIMARY KEY';
  else if (column.unique) line += ' UNIQUE';
  if (column.defaultValue !== undefined) line += ` DEFAULT ${column.defaultValue}`;
  if (column.references) line += ` FOREIGN KEY -> ${column.references}`;
  let commentRendered = false;
  if (includeComments && column.comment) {
    const cleaned = cleanColumnComment(column.comment);
    const dict = extractDictFragment(column.name, column.comment);
    const text = dict ? (cleaned ? `${cleaned}；${dict}` : dict) : cleaned;
    if (text) {
      line += ` -- ${text}`;
      commentRendered = true;
    }
  }
  if (isSensitive(column.name)) line += ' [SENSITIVE]';
  return { line, commentRendered };
}