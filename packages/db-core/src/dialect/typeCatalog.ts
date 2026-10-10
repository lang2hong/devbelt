import { DatabaseType } from '../types/connection.js';

/**
 * 各方言的列类型候选表（表设计器类型下拉用）。
 *
 * 收敛在此处而非 webview：方言差异属于 db-core 职责，前端只消费
 * `SqlDialect.columnTypes`，避免 UI 里硬编码某一家的类型集合。
 * 带参类型给出常用默认参数（如 `VARCHAR(255)`）作为起点，用户可改。
 */

const MYSQL_TYPES: readonly string[] = [
  // 整型
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT',
  'TINYINT UNSIGNED', 'SMALLINT UNSIGNED', 'MEDIUMINT UNSIGNED', 'INT UNSIGNED', 'BIGINT UNSIGNED',
  'BIT(1)', 'BOOLEAN',
  // 定点/浮点
  'DECIMAL(10,2)', 'NUMERIC(10,2)', 'FLOAT', 'DOUBLE',
  // 字符串
  'CHAR(36)', 'VARCHAR(255)', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  "ENUM('a','b')", "SET('a','b')",
  // 二进制
  'BINARY(16)', 'VARBINARY(255)', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB',
  // 日期时间
  'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
  'DATETIME(3)', 'TIMESTAMP(3)',
  // 其它
  'JSON', 'GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON',
];

const PG_TYPES: readonly string[] = [
  // 整型与自增
  'SMALLINT', 'INTEGER', 'BIGINT', 'SMALLSERIAL', 'SERIAL', 'BIGSERIAL',
  // 定点/浮点
  'NUMERIC(10,2)', 'DECIMAL(10,2)', 'REAL', 'DOUBLE PRECISION', 'MONEY',
  // 字符串
  'CHAR(36)', 'CHARACTER VARYING(255)', 'VARCHAR(255)', 'TEXT', 'CITEXT',
  // 布尔/二进制
  'BOOLEAN', 'BYTEA',
  // 日期时间
  'DATE', 'TIME', 'TIME WITH TIME ZONE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE',
  'TIMESTAMPTZ', 'INTERVAL',
  // 结构化
  'JSON', 'JSONB', 'UUID', 'XML',
  // 数组
  'INTEGER[]', 'TEXT[]', 'JSONB[]',
  // 网络/范围/其它
  'INET', 'CIDR', 'MACADDR', 'INT4RANGE', 'TSRANGE', 'TSVECTOR',
];

const SQLITE_TYPES: readonly string[] = [
  // SQLite 只有 5 种存储类，但接受任意类型名并按亲和性规则映射，
  // 故同时给出存储类与常见兼容写法。
  'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
  'VARCHAR(255)', 'CHAR(36)', 'CLOB',
  'DECIMAL(10,2)', 'DOUBLE', 'FLOAT',
  'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP',
];

const CATALOG: Record<DatabaseType, readonly string[]> = {
  [DatabaseType.MYSQL]: MYSQL_TYPES,
  [DatabaseType.PG]: PG_TYPES,
  [DatabaseType.SQLITE]: SQLITE_TYPES,
  // Redis 是 KV/数据结构引擎，无 SQL 列类型概念。
  [DatabaseType.REDIS]: [],
  // Elasticsearch 是文档/搜索引擎，无 SQL 列类型概念（mapping 由 ES 管理）。
  [DatabaseType.ELASTICSEARCH]: [],
};

/** 取指定方言的列类型候选；未知类型回退 MySQL 集合。 */
export function columnTypesFor(dbType: DatabaseType): readonly string[] {
  return CATALOG[dbType] ?? MYSQL_TYPES;
}
