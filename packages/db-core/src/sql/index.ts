/**
 * `@devbelt/db-core/sql` 公共入口：SQL 词法 + 两套切分适配器 + 风险分类。
 *
 * 这里是全仓唯一的 SQL 词法来源。上层（vscode-ext 的 `utils/sql.ts`、
 * `utils/sqlRisk.ts`）从这里取 `scanSql`/`sqlSkeleton`/切分函数，
 * 不再各自维护扫描规则；风险分类（`analyzeSqlRisk`/`classifyWriteKind`）
 * 由执行门禁与 AI 标签共用同一实现。
 */
export { scanSql, sqlSkeleton, usesDelimiterDirective, SqlScanner } from './lexer.js';
export type { SqlSegment, SqlSegmentKind, SqlScanOptions, SqlScannedSegment } from './lexer.js';
export { splitSqlWithRanges, splitExecutableStatements, stripSqlComments, StreamingStatementSplitter } from './split.js';
export type { SqlStatementRange } from './split.js';
export { sqlCommentSafe } from './comment.js';
export { scanOptionsForDbType } from './scanOptions.js';
export { scanOptionsForDialect } from './scanOptions.js';
export { parseNoBackslashEscapes } from './scanOptions.js';
export { parseStandardConformingStringsOff } from './scanOptions.js';
export { escapeStringLiteralContent } from './escapeLiteral.js';
export { TX_CONTROL_SQL, isTxControlStatement } from './txControl.js';
export { analyzeSqlRisk, classifyWriteKind } from './risk.js';
export type { SqlRisk, SqlRiskLevel } from './risk.js';