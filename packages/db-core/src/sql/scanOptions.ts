import { DatabaseType } from '../types/connection.js';
import type { SqlScanOptions } from './lexer.js';

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
  opts: { noBackslashEscapes?: boolean } = {},
): SqlScanOptions {
  const mysql = dbType === DatabaseType.MYSQL;
  return {
    hashComment: mysql,
    dashDashRequiresSpace: mysql,
    // MySQL 默认把 `\` 当转义；服务端 sql_mode 含 NO_BACKSLASH_ESCAPES 时不然。
    backslashEscapes: mysql && opts.noBackslashEscapes !== true,
    // PG 的 `E'...'` 串始终启用反斜杠转义，与 standard_conforming_strings 无关。
    escapeStringPrefix: dbType === DatabaseType.PG,
  };
}