/**
 * @devkit/db-core 公共入口。
 * 统一导出连接、方言、工厂、查询与类型，供上层（vscode-ext）使用。
 */

// 类型（领域模型）
export * from './types/connection.js';
export * from './types/meta.js';
export * from './types/query.js';

// 连接抽象与适配器
export { IConnection } from './connection/connection.js';
export { MysqlConnection } from './connection/mysqlConnection.js';
export { PostgreSqlConnection } from './connection/postgreSqlConnection.js';
export { SqliteConnection } from './connection/sqliteConnection.js';

// 方言（策略模式）
export { SqlDialect } from './dialect/sqlDialect.js';
export { MysqlDialect } from './dialect/mysqlDialect.js';
export { PostgreSqlDialect } from './dialect/postgreSqlDialect.js';
export { SqliteDialect } from './dialect/sqliteDialect.js';
export { DialectRegistry } from './dialect/dialectRegistry.js';
export { supportsOperation, unsupportedOperationMessage } from './dialect/capabilities.js';
export type { DatabaseCapabilities, DatabaseOperation } from './dialect/capabilities.js';

// 工厂
export { ConnectionFactory } from './factory/connectionFactory.js';

// 工具
export { validateIdent } from './utils/validate.js';
export { toBool } from './utils/coerce.js';
export { columnTypesFor } from './dialect/typeCatalog.js';

// 查询层
export { QueryService, QueryError } from './query/queryService.js';
export type { QueryOptions, QueryCancelToken, ExecutedStatement, QueryObserver } from './query/queryService.js';
export { MetadataService } from './query/metadataService.js';
export { DataService } from './query/dataService.js';
export { TableService } from './query/tableService.js';
export { validateColumnType } from './query/columnSpec.js';
export type { NewColumnSpec, ColumnSpec } from './query/columnSpec.js';
export { SchemaDiffService } from './query/schemaDiffService.js';
export type { TableDiff, ColumnDiff } from './query/schemaDiffService.js';
export { DataDiffService } from './query/dataDiffService.js';
export type { DataDiffResult, TableDataDiff, RowDiff, RowDiffStatus } from './query/dataDiffService.js';
export { BackupService } from './query/backupService.js';
export type { BackupOptions, BackupProgress, RestoreOptions, RestoreProgress } from './query/backupService.js';
export { streamRowsByKeyset } from './query/paging.js';
export type { KeysetQuerySource } from './query/paging.js';
export { DataTransferService } from './query/dataTransferService.js';
export type { TransferOptions, TransferProgress } from './query/dataTransferService.js';
