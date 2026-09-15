import { DatabaseType } from '@db-client/core';
import type { SqlScanOptions } from '@db-client/core/sql';

/**
 * 由连接方言派生 SQL 扫描选项（单一派发点）。
 *
 * - MySQL：`#` 是行注释；`--` 只有在后跟空白/控制/行尾时才是注释（`1--2` 是减法）；
 *   字符串里反斜杠转义下一个字符。
 * - 其余方言（含 dbType 缺失）：`#` 按代码处理（PG 里是运算符），`--` 恒为注释；
 *   反斜杠是普通字符（PG 默认 `standard_conforming_strings=on`、SQLite 亦然）。
 *
 * 新增调用点应一律经此派生，而不是各自手写选项，以免漏传退化回 MySQL 只读绕过。
 */
export function dialectScanOptions(dbType: DatabaseType | undefined): SqlScanOptions {
  const mysql = dbType === DatabaseType.MYSQL;
  return { hashComment: mysql, dashDashRequiresSpace: mysql, backslashEscapes: mysql };
}