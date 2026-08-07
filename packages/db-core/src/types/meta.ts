/**
 * 字段元信息（复用自原项目 common/typeDef.ts）。
 */
export interface FieldInfo {
  catalog: string;
  db: string;
  schema: string;
  table: string;
  orgTable: string;
  name: string;
  orgName: string;
  charsetNr: number;
  length: number;
  flags: number;
  decimals: number;
  default?: string;
  zeroFill: boolean;
  protocol41: boolean;
  type: number;
}

/** 列元信息 */
export interface ColumnMeta {
  name: string;
  simpleType: string;
  type: string;
  comment: string;
  key: string;
  nullable: string;
  maxLength: string;
  defaultValue: any;
  extra: any;
  isNotNull: boolean;
  isAutoIncrement: boolean;
  isUnique: boolean;
  isPrimary: boolean;
  pk: string;
}

/** 表元信息 */
export interface TableMeta {
  name: string;
  comment: string;
  table_rows?: string;
  auto_increment?: string;
  /** clustered bytes * pagesize */
  data_length?: string;
  /** clustered bytes * pagesize */
  index_length?: string;
}

/** 视图元信息 */
export interface ViewMeta extends TableMeta {
  /** pg only, material: material view */
  type?: string;
}

/** 函数/存储过程元信息 */
export interface RoutineMeta {
  name: string;
  /** FUNCTION | PROCEDURE */
  type: string;
  comment?: string;
}

/** 事件元信息（MySQL EVENT SCHEDULE） */
export interface EventMeta {
  name: string;
  definer?: string;
  eventType?: string;
  comment?: string;
}

/** 索引元信息 */
export interface IndexMeta {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  type?: string;
}

/** 用户元信息 */
export interface UserMeta {
  name: string;
  host?: string;
}

/** 本地保存的查询（Navicat Queries 分类的本地存储） */
export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connId: string;
  database?: string;
  createdAt: number;
  updatedAt: number;
}