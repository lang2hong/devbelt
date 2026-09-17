/**
 * `@devkit/core/sql` 公共入口：SQL 词法 + 两套切分适配器。
 *
 * 这里是全仓唯一的 SQL 词法来源。上层（vscode-ext 的 `utils/sql.ts`、
 * `utils/sqlRisk.ts`）从这里取 `scanSql`/`sqlSkeleton`/切分函数，
 * 不再各自维护扫描规则。
 */
export { scanSql, sqlSkeleton, usesDelimiterDirective } from './lexer.js';
export type { SqlSegment, SqlSegmentKind, SqlScanOptions } from './lexer.js';
export { splitSqlWithRanges, splitExecutableStatements } from './split.js';
export type { SqlStatementRange } from './split.js';
export { sqlCommentSafe } from './comment.js';
export { scanOptionsForDbType } from './scanOptions.js';