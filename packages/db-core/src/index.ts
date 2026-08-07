/**
 * @db-client/core 公共入口。
 * 统一导出连接、方言、工厂、查询与类型，供上层（vscode-ext）使用。
 */

// 类型（领域模型）
export * from './types/connection';
export * from './types/meta';
export * from './types/query';

// 连接抽象与适配器
export { IConnection } from './connection/connection';
export { MysqlConnection } from './connection/mysqlConnection';
export { PostgreSqlConnection } from './connection/postgreSqlConnection';
export { SqliteConnection } from './connection/sqliteConnection';

// 方言（策略模式）
export { SqlDialect } from './dialect/sqlDialect';
export { MysqlDialect } from './dialect/mysqlDialect';
export { PostgreSqlDialect } from './dialect/postgreSqlDialect';
export { SqliteDialect } from './dialect/sqliteDialect';
export { DialectRegistry } from './dialect/dialectRegistry';

// 工厂
export { ConnectionFactory } from './factory/connectionFactory';

// 查询层
export { QueryService, QueryError } from './query/queryService';
export { MetadataService } from './query/metadataService';
export { DataService } from './query/dataService';
export { TableService } from './query/tableService';
export { SchemaDiffService } from './query/schemaDiffService';
export type { TableDiff, ColumnDiff } from './query/schemaDiffService';
export type { RoutineMeta, EventMeta, SavedQuery, IndexMeta, UserMeta, ForeignKeyMeta } from './types/meta';