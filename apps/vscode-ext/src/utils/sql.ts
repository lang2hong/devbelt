import { DatabaseType } from '@devkit/db-core';
import type { SavedConnection } from '../connection/connectionStore';
import { splitSqlWithRanges } from '@devkit/db-core/sql';
import type { SqlScanOptions } from '@devkit/db-core/sql';

/**
 * SQL 标识符包裹工具（统一 wrapIdent / wrapQualified，消除重复）。
 *
 * MySQL/SQLite 用反引号，PostgreSQL 用双引号。内嵌的引号必须按方言规则
 * 翻倍（`` ` ``→`` `` ``, `"`→`""`），否则含引号的库/表/列名会逃出标识符上下文。
 */
export function wrapIdent(dbType: DatabaseType, name: string): string {
  return dbType === DatabaseType.MYSQL
    ? '`' + name.replace(/`/g, '``') + '`'
    : '"' + name.replace(/"/g, '""') + '"';
}

/** 便捷版：基于已保存连接。 */
export function wrapIdentForConn(conn: SavedConnection, name: string): string {
  return wrapIdent(conn.dbType, name);
}

/**
 * 转义 SQL 字符串字面量内容（不含外层引号，防注入）。
 *
 * 转义规则按方言分流：MySQL 默认开启反斜杠转义，`\` 需翻倍；
 * PostgreSQL（standard_conforming_strings=on）与 SQLite 中反斜杠无转义语义，
 * 若照 MySQL 规则翻倍会把一个反斜杠写成两个字面反斜杠，导致匹配错误行。
 *
 * `dbType` 是**必填**：原先可省略并默认按 MySQL 处理，一旦调用方漏传，
 * PG/SQLite 上就会静默过度转义。方言差异不该有「默认值」。
 */
export function escapeSqlString(value: string, dbType: DatabaseType): string {
  const escaped = String(value).replace(/'/g, "''");
  return dbType === DatabaseType.MYSQL
    ? escaped.replace(/\\/g, '\\\\')
    : escaped;
}

/**
 * 语句切分复用 `@devkit/db-core/sql`（全仓唯一词法来源）。
 *
 * 编辑器侧语义：保留注释、带位置（供 CodeLens）。db-core 侧另有
 * `splitExecutableStatements`（丢弃注释），两者共享同一 lexer。
 */
export { splitSqlWithRanges };
export type { SqlStatementRange } from '@devkit/db-core/sql';

/**
 * 拆分 SQL 语句（按分号，感知引号、注释、美元引用与 DELIMITER）。
 * 只要文本不要位置时用这个；需要位置见 `splitSqlWithRanges`。
 */
export function splitSqlStatements(sql: string, options?: SqlScanOptions): string[] {
  return splitSqlWithRanges(sql, options).map((s) => s.sql);
}
