import { DatabaseType } from '../types/connection.js';
import type { SqlScanOptions } from './lexer.js';
import type { SqlDialect } from '../dialect/sqlDialect.js';

/**
 * 由方言派生 SQL 扫描选项（**单一来源**）。
 *
 * - MySQL：`#` 是行注释；`--` 只有后跟空白/控制/行尾才是注释（`1--2` 是减法）；
 *   字符串里反斜杠转义下一个字符（`\'` 不是结束）。
 * - 其余方言（含 dbType 缺失）：`#` 按代码、`--` 恒为注释、反斜杠为普通字符
 *   （PG 默认 `standard_conforming_strings=on`、SQLite 亦然）。
 *
 * db-core 内部切分（如 schema/data 同步的生成 SQL）与 vscode-ext 编辑器侧都必须
 * 经此派生，避免「忘记传选项」退化到默认标准语义而误切 MySQL 的 `\'`。
 */
export function scanOptionsForDbType(
  dbType: DatabaseType | undefined,
  opts: { noBackslashEscapes?: boolean; standardConformingStrings?: boolean } = {},
): SqlScanOptions {
  const mysql = dbType === DatabaseType.MYSQL;
  const pg = dbType === DatabaseType.PG;
  return {
    hashComment: mysql,
    dashDashRequiresSpace: mysql,
    // MySQL 默认把 `\` 当转义；NO_BACKSLASH_ESCAPES 时不然。
    // PG 默认不然（standard_conforming_strings=on）；该 GUC 为 off 时普通串里 `\` 是转义。
    backslashEscapes:
      (mysql && opts.noBackslashEscapes !== true) ||
      (pg && opts.standardConformingStrings === false),
    // PG 的 `E'...'` 串始终启用反斜杠转义，与 standard_conforming_strings 无关。
    escapeStringPrefix: pg,
  };
}

/**
 * 由方言实例派生扫描选项：带上连接级模式（MySQL `noBackslashEscapes`、
 * PG `standardConformingStrings`）。db-core 内部生成 SQL 的切分应经此，
 * 避免只传 dbType 而丢掉连接级语义。
 */
export function scanOptionsForDialect(
  dialect: Pick<SqlDialect, 'dbType' | 'noBackslashEscapes' | 'standardConformingStrings'>,
): SqlScanOptions {
  return scanOptionsForDbType(dialect.dbType, {
    noBackslashEscapes: dialect.noBackslashEscapes === true,
    standardConformingStrings: dialect.standardConformingStrings,
  });
}

/**
 * 解析 MySQL `@@sql_mode` 是否含 NO_BACKSLASH_ESCAPES（大小写不敏感）。
 *
 * 单一来源：连接层读到模式后据此决定扫描选项与值转义方言，避免各处
 * 各写一份正则而漂移。
 */
export function parseNoBackslashEscapes(sqlMode: string | null | undefined): boolean {
  return /NO_BACKSLASH_ESCAPES/i.test(sqlMode ?? '');
}

/**
 * 解析 PG `standard_conforming_strings` 是否为 off（默认 on）。
 *
 * 单一来源：连接层读到该 GUC 后据此决定扫描选项与值转义方言，避免各处
 * 各写一份判断而漂移。
 */
export function parseStandardConformingStringsOff(value: string | null | undefined): boolean {
  return /^\s*off\s*$/i.test(String(value ?? ''));
}